import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
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
import { isSessionRecord } from "./session.ts";

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

export function withLocalBinPath(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const bin = join(root, "node_modules", ".bin");
  const out: NodeJS.ProcessEnv = {
    ...env,
    PATH: `${bin}${delimiter}${env.PATH ?? ""}`,
  };
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
      "Jest is detect-only; Slim does not wrap Jest. Use node:test (--import slim/hooks) or Vitest (slim/vitest), or pass --no-trace for static-only evidence (cannot claim trace closure).",
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
    runner.kind === "vitest"
      ? writeVitestTraceConfig(root, uniq, opts?.traceDir ?? join(root, ".slim"))
      : undefined;
  const spawn = buildTraceSpawn(runner, { hookPath: hook, vitestConfigPath });
  if (!spawn) {
    throw new SlimExit(EXIT_ENV, `cannot build ${runner.kind} trace spawn`);
  }

  const timeoutMs = opts?.timeoutMs ?? TRACE_TIMEOUT_MS;
  process.stderr.write(`tracing via ${runner.kind}…\n`);
  const r = spawnSync(spawn.file, spawn.args, {
    cwd: root,
    env: withLocalBinPath(root, envVars),
    encoding: "utf8",
    timeout: timeoutMs,
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
      `trace run exited ${r.status ?? "null"}\n${(r.stderr ?? "").slice(0, 800)}`,
    );
  }

  const parsed = readTraceFile(outPath);
  if (!parsed.sawSession) {
    const detail = [(r.stderr ?? "").trim(), (r.stdout ?? "").trim()].filter(Boolean).join("\n").slice(0, 800);
    throw new SlimExit(
      EXIT_ENV,
      `trace hook did not load (missing session header). Check slim/hooks or slim/vitest resolution.${detail ? `\n${detail}` : ""}`,
    );
  }
  if (!parsed.events.length) return env;
  return mergeTraces(env, parsed.events, { root });
}

export function readTraceFile(path: string): { sawSession: boolean; events: TraceEvent[] } {
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
    events.push(parsed as TraceEvent);
    if (events.length > MAX_TRACE_EVENTS) {
      throw new SlimExit(EXIT_FAIL, `trace event count exceeds ${MAX_TRACE_EVENTS}`);
    }
  }
  return { sawSession, events };
}
