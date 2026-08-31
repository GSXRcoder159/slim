import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveScriptFile, scriptSpawnOpts } from "../rewrite/lockfile.ts";
import { siblingModule } from "../runtime-path.ts";
import { EXIT_ENV, EXIT_FAIL, SlimExit } from "../exit.ts";
import type { Envelope, TraceEvent } from "../envelope/types.ts";
import { mergeTraces } from "../envelope/merge.ts";
import { resolvePackageFamily } from "../analyze/family.ts";
import {
  detectRunner,
  writeVitestTraceConfig,
  buildTraceSpawn,
  traceEnv,
} from "./runners.ts";
import { isErrorRecord, isSessionRecord, type TraceErrorRecord } from "./session.ts";

export const TRACE_TIMEOUT_MS = 120_000;
export const MAX_TRACE_BYTES = 32 * 1024 * 1024;
export const MAX_TRACE_EVENTS = 50_000;

export function writeTracesMeta(pkgDir: string): void {
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "traces.meta.json"), JSON.stringify({ uploaded: false }) + "\n");
}

/** Host test-runner IPC vars must not leak into a nested trace/merge spawn. */
const HOST_TEST_ENV = [
  "NODE_TEST_CONTEXT",
  "NODE_CHANNEL_FD",
  "NODE_UNIQUE_ID",
  "VITEST_WORKER_ID",
  "VITEST_POOL_ID",
];

function readEnvPath(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function writeEnvPath(env: NodeJS.ProcessEnv, value: string): void {
  delete env.Path;
  delete env.path;
  env.PATH = value;
}

export function withLocalBinPath(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const bin = join(root, "node_modules", ".bin");
  const out: NodeJS.ProcessEnv = { ...env };
  writeEnvPath(out, `${bin}${delimiter}${readEnvPath(out)}`);
  for (const k of HOST_TEST_ENV) delete out[k];
  return out;
}

export function runTraces(
  root: string,
  pkg: string,
  env: Envelope,
  opts?: { timeoutMs?: number; traceDir?: string },
): Envelope {
  const runner = detectRunner(root);
  if (runner.kind === "jest") {
    if (runner.jestSnippet) process.stderr.write(runner.jestSnippet + "\n");
    throw new SlimExit(
      EXIT_ENV,
      "Jest is detect-only; Slim does not wrap Jest. Use node:test (--import @gsxrcoder159/slim/hooks) or Vitest (@gsxrcoder159/slim/vitest), or pass --no-trace for static-only evidence (cannot claim trace closure).",
    );
  }
  if (runner.kind === "none" || !runner.command) {
    throw new SlimExit(
      EXIT_ENV,
      "no test runner for traces. Add a node:test or Vitest script, or pass --no-trace for static-only evidence (cannot claim trace closure).",
    );
  }

  const pkgDir = opts?.traceDir ?? join(root, ".slim", env.package.name);
  const outPath = join(pkgDir, "traces.jsonl");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(outPath, "");
  writeTracesMeta(pkgDir);

  let hook: string;
  try {
    hook = siblingModule(import.meta.url, "hook");
  } catch (err) {
    throw new SlimExit(
      EXIT_ENV,
      `trace hook missing: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const fam = resolvePackageFamily(pkg);
  const packages = [pkg, env.package.name, fam?.name, fam?.family].filter(Boolean) as string[];
  if (fam?.family === "lodash") packages.push("lodash", "lodash-es");
  const uniq = [...new Set(packages)];
  const envVars = {
    ...traceEnv(uniq, outPath),
    SLIM_TRACE_ROOT: root,
  };
  const vitestConfigPath =
    runner.kind === "vitest" ? writeVitestTraceConfig(root, uniq) : undefined;
  const spawn = buildTraceSpawn(runner, { hookPath: hook, vitestConfigPath });
  if (!spawn) {
    throw new SlimExit(EXIT_ENV, `cannot build ${runner.kind} trace spawn`);
  }

  const timeoutMs = opts?.timeoutMs ?? TRACE_TIMEOUT_MS;
  process.stderr.write(`tracing via ${runner.kind}…\n`);
  const file = resolveScriptFile(spawn.file);
  const r = spawnSync(file, spawn.args, {
    cwd: root,
    env: withLocalBinPath(root, envVars),
    encoding: "utf8",
    timeout: timeoutMs,
    ...scriptSpawnOpts(file),
  });

  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    throw new SlimExit(EXIT_ENV, `trace run timed out after ${timeoutMs}ms`);
  }
  if (r.status == null && r.signal) {
    throw new SlimExit(EXIT_ENV, `trace run killed by signal ${r.signal}`);
  }
  if (r.status !== 0) {
    throw new SlimExit(
      EXIT_FAIL,
      `trace run exited ${r.status ?? "null"}\n${[(r.stderr ?? "").trim(), (r.stdout ?? "").trim()].filter(Boolean).join("\n").slice(0, 800)}`,
    );
  }

  const parsed = readTraceFile(outPath);
  if (!parsed.sawSession) {
    const detail = [(r.stderr ?? "").trim(), (r.stdout ?? "").trim()].filter(Boolean).join("\n").slice(0, 800);
    throw new SlimExit(
      EXIT_ENV,
      `trace hook did not load (missing session header). Check @gsxrcoder159/slim/hooks or @gsxrcoder159/slim/vitest resolution.${detail ? `\n${detail}` : ""}`,
    );
  }
  if (parsed.errors.length) {
    const first = parsed.errors[0]!;
    throw new SlimExit(
      EXIT_FAIL,
      `trace ${first.kind}${first.message ? `: ${first.message}` : ""}`,
    );
  }
  if (!parsed.events.length) {
    throw new SlimExit(
      EXIT_FAIL,
      "zero package events; runtime not observed. Pass --no-trace for static-only evidence (cannot claim trace closure).",
    );
  }
  const merged = mergeTraces(env, parsed.events, { root });
  if (merged.traces.some((t) => t.unmatched)) {
    throw new SlimExit(
      EXIT_FAIL,
      "unmatched trace events; cannot attribute runtime observations to static call sites",
    );
  }
  return merged;
}

export function readTraceFile(path: string): {
  sawSession: boolean;
  events: TraceEvent[];
  errors: TraceErrorRecord[];
} {
  if (!existsSync(path)) {
    throw new SlimExit(EXIT_FAIL, `trace file missing: ${path}`);
  }
  const st = statSync(path);
  if (st.size > MAX_TRACE_BYTES) {
    throw new SlimExit(EXIT_FAIL, `trace file exceeds ${MAX_TRACE_BYTES} bytes`);
  }
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  let sawSession = false;
  const events: TraceEvent[] = [];
  const errors: TraceErrorRecord[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new SlimExit(EXIT_FAIL, `malformed trace JSONL: ${line.slice(0, 120)}`);
    }
    if (isSessionRecord(parsed)) {
      sawSession = true;
      continue;
    }
    if (isErrorRecord(parsed)) {
      errors.push(parsed);
      continue;
    }
    if (!isTraceEvent(parsed)) {
      throw new SlimExit(EXIT_FAIL, `malformed trace JSONL: ${line.slice(0, 120)}`);
    }
    events.push(parsed);
    if (events.length > MAX_TRACE_EVENTS) {
      throw new SlimExit(EXIT_FAIL, `trace event count exceeds ${MAX_TRACE_EVENTS}`);
    }
  }
  return { sawSession, events, errors };
}

function isTraceEvent(v: unknown): v is TraceEvent {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.symbol !== "string" || !Array.isArray(o.args)) return false;
  const refs = { count: 0 };
  if (!o.args.every((arg) => isSlimValue(arg, refs))) return false;
  if (o.thisArg !== undefined && !isSlimValue(o.thisArg, refs)) return false;
  if (o.result !== undefined && !isSlimValue(o.result, refs)) return false;
  if (o.argsAfter !== undefined) {
    if (!Array.isArray(o.argsAfter) || !o.argsAfter.every((arg) => isSlimValue(arg, refs))) return false;
  }
  if (o.thisAfter !== undefined && !isSlimValue(o.thisAfter, refs)) return false;
  return true;
}

function isSlimValue(v: unknown, refs: { count: number }): v is TraceEvent["args"][number] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.t !== "string") return false;
  const stringList = (x: unknown): x is string[] => Array.isArray(x) && x.every((n) => typeof n === "string");
  const numberList = (x: unknown): x is number[] => Array.isArray(x) && x.every((n) => typeof n === "number");
  const nested = (x: unknown): x is TraceEvent["args"][number] => isSlimValue(x, refs);
  if (["date", "err", "fn", "arr", "obj", "map", "set", "bytes", "promise", "regexp"].includes(o.t)) refs.count++;
  switch (o.t) {
    case "undef": case "null": case "promise": case "trunc":
      return Object.keys(o).length === 1;
    case "bool": return typeof o.v === "boolean";
    case "num": return (typeof o.v === "number" && Number.isFinite(o.v)) ||
      (o.v === "NaN" || o.v === "-0" || o.v === "Infinity" || o.v === "-Infinity");
    case "str": return typeof o.v === "string" && (o.redacted === undefined || typeof o.redacted === "boolean");
    case "bigint": return typeof o.v === "string";
    case "date": return typeof o.v === "number" && Number.isFinite(o.v);
    case "err": return typeof o.name === "string" && typeof o.message === "string" &&
      (o.code === undefined || typeof o.code === "string" || typeof o.code === "number");
    case "fn": return (o.name === undefined || typeof o.name === "string") &&
      (o.length === undefined || (typeof o.length === "number" && Number.isInteger(o.length)));
    case "regexp": return typeof o.source === "string" && typeof o.flags === "string";
    case "bytes": return (o.kind === undefined || typeof o.kind === "string") &&
      (o.len === undefined || (typeof o.len === "number" && Number.isInteger(o.len) && o.len >= 0)) &&
      (o.b64 === undefined || typeof o.b64 === "string");
    case "ref": return typeof o.id === "number" && Number.isInteger(o.id) && o.id >= 0 && o.id < refs.count;
    case "arr": {
      if (!Array.isArray(o.v) || !numberList(o.holes)) return false;
      const values = o.v;
      if (o.holes.some((n) => !Number.isInteger(n) || n < 0 || n >= values.length)) return false;
      if (new Set(o.holes).size !== o.holes.length || !values.every(nested)) return false;
      return true;
    }
    case "obj": {
      if (!stringList(o.keys) || !o.v || typeof o.v !== "object" || Array.isArray(o.v)) return false;
      const fields = o.v as Record<string, unknown>;
      if (new Set(o.keys).size !== o.keys.length || o.keys.some((k) => !Object.prototype.hasOwnProperty.call(fields, k))) return false;
      if (!o.keys.every((k) => nested(fields[k]))) return false;
      if (o.proto !== undefined && !["null", "object", "other"].includes(String(o.proto))) return false;
      if (o.toStr !== undefined && typeof o.toStr !== "boolean") return false;
      if (o.str !== undefined && typeof o.str !== "string") return false;
      if (o.json !== undefined && typeof o.json !== "string") return false;
      if (o.syms !== undefined && (!Array.isArray(o.syms) || !o.syms.every((s) => {
        if (!s || typeof s !== "object") return false;
        const x = s as Record<string, unknown>;
        return typeof x.k === "string" && (x.g === undefined || typeof x.g === "boolean") && nested(x.v);
      }))) return false;
      return true;
    }
    case "map": return Array.isArray(o.v) && o.v.every((p) => Array.isArray(p) && p.length === 2 && nested(p[0]) && nested(p[1]));
    case "set": return Array.isArray(o.v) && o.v.every(nested);
    default: return false;
  }
}
