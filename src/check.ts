import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { CliArgs } from "./cli.ts";
import { EXIT_FAIL, EXIT_OK, SlimExit } from "./exit.ts";
import { loadProject, loadTargetTypescript } from "./project.ts";
import { loadConfig } from "./config.ts";
import { analyzePackage } from "./analyze/index.ts";
import { specifierMatches, wantedSpecifiers } from "./analyze/reexports.ts";
import { withLocalBinPath } from "./replace.ts";
import { resolveScriptFile, scriptSpawnOpts } from "./rewrite/lockfile.ts";
import { JSON_SCHEMA_VERSION, statusFromExit, writeJson } from "./json.ts";
import { assertDocument, readDocument } from "./schema/documents.ts";
import { diffEnvelope, type EnvelopeDrift } from "./envelope/drift.ts";
import type { Envelope } from "./envelope/types.ts";
import { checkContracts } from "./generate/exports.ts";
import { detectRunner } from "./trace/runners.ts";
import {
  evidenceScript,
  hardeningTestPaths,
  hasStandingTests,
  standingTestPaths,
} from "./evidence/paths.ts";
import {
  replacementStateIssues,
  type ReplacementRecord,
} from "./upstream/state.ts";

export { evidenceScript, hardeningTestPaths, standingTestPaths } from "./evidence/paths.ts";

export type CheckSpawn = (
  command: string,
  args?: readonly string[],
  options?: SpawnSyncOptions,
) => Pick<SpawnSyncReturns<string | Buffer>, "status" | "signal" | "error"> & {
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

export interface RunCheckOpts {
  cwd?: string;
  spawn?: CheckSpawn;
}

export interface CheckPackageResult {
  pkg: string;
  ok: boolean;
  drift: EnvelopeDrift[];
  unknowns: string[];
  standing: "pass" | "fail" | "missing";
  residualRisk: string[];
}

export interface CheckReport {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  ok: boolean;
  exit: number;
  status: ReturnType<typeof statusFromExit>;
  packages: CheckPackageResult[];
}

function childText(chunk: string | Buffer | null | undefined): string {
  if (chunk == null) return "";
  return typeof chunk === "string" ? chunk : chunk.toString("utf8");
}

export const DEFAULT_CHECK_CHILD_TIMEOUT_MS = 600_000;

export function checkChildTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SLIM_CHECK_CHILD_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_CHECK_CHILD_TIMEOUT_MS;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new SlimExit(EXIT_FAIL, "SLIM_CHECK_CHILD_TIMEOUT_MS must be a positive integer");
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new SlimExit(EXIT_FAIL, "SLIM_CHECK_CHILD_TIMEOUT_MS must be a positive integer");
  }
  return n;
}

function childTimedOut(r: { error?: NodeJS.ErrnoException | Error | null }): boolean {
  const err = r.error as NodeJS.ErrnoException | undefined;
  return err?.code === "ETIMEDOUT";
}

/** POSIX spawnSync sets `signal`; Windows abort/kill usually returns a status > 1 with `signal` null. */
function childEndedAbnormally(r: { status: number | null; signal: NodeJS.Signals | null }): boolean {
  if (r.signal) return true;
  if (r.status == null) return false;
  return r.status > 128;
}

function spawnChecked(
  spawn: CheckSpawn,
  command: string,
  args: string[],
  root: string,
  failMessage: string,
  json: boolean,
): void {
  const file = resolveScriptFile(command);
  const r = spawn(file, args, {
    cwd: root,
    encoding: "utf8",
    stdio: json ? ["ignore", "pipe", "pipe"] : "inherit",
    env: withLocalBinPath(root),
    ...scriptSpawnOpts(file),
    timeout: checkChildTimeoutMs(),
  });
  if (json) {
    const out = childText(r.stdout);
    const err = childText(r.stderr);
    if (out) process.stderr.write(out);
    if (err) process.stderr.write(err);
  }
  if (r.status === 0) return;
  if (childTimedOut(r)) {
    throw new SlimExit(EXIT_FAIL, `${failMessage} timed out`);
  }
  if (childEndedAbnormally(r)) {
    throw new SlimExit(
      EXIT_FAIL,
      `${failMessage} terminated abnormally (${r.signal ?? r.status})`,
    );
  }
  throw new SlimExit(EXIT_FAIL, failMessage);
}

export function runStandingTests(
  root: string,
  pkg: string,
  outDir: string,
  spawn: CheckSpawn = spawnSync,
  json = false,
): void {
  const evidence = evidenceScript(root);
  if (evidence) {
    const parts = evidence.split(/\s+/).filter(Boolean);
    spawnChecked(spawn, parts[0]!, parts.slice(1), root, `standing tests failed for ${pkg}`, json);
    return;
  }
  const { tsRel, jsRel, tsAbs, jsAbs } = standingTestPaths(root, pkg, outDir);
  if (existsSync(tsAbs)) {
    spawnChecked(
      spawn,
      process.execPath,
      ["--experimental-strip-types", "--test", tsRel],
      root,
      `standing tests failed for ${pkg}`,
      json,
    );
    return;
  }
  if (existsSync(jsAbs)) {
    spawnChecked(spawn, process.execPath, ["--test", jsRel], root, `standing tests failed for ${pkg}`, json);
  }
}

export function runHardenedTests(
  root: string,
  moduleRel: string | undefined,
  spawn: CheckSpawn = spawnSync,
  json = false,
): void {
  if (!moduleRel) return;
  const { tsRel, jsRel, tsAbs, jsAbs } = hardeningTestPaths(root, moduleRel);
  const vitest = detectRunner(root).kind === "vitest";
  if (existsSync(tsAbs)) {
    if (vitest) {
      spawnChecked(spawn, "vitest", ["run", tsRel], root, `hardening tests failed for ${moduleRel}`, json);
    } else {
      spawnChecked(
        spawn,
        process.execPath,
        ["--experimental-strip-types", "--test", tsRel],
        root,
        `hardening tests failed for ${moduleRel}`,
        json,
      );
    }
    return;
  }
  if (existsSync(jsAbs)) {
    if (vitest) {
      spawnChecked(spawn, "vitest", ["run", jsRel], root, `hardening tests failed for ${moduleRel}`, json);
    } else {
      spawnChecked(spawn, process.execPath, ["--test", jsRel], root, `hardening tests failed for ${moduleRel}`, json);
    }
  }
}

export function runConfiguredTestCommand(
  root: string,
  testCommand: string | null,
  spawn: CheckSpawn = spawnSync,
  json = false,
): void {
  const cmd = testCommand?.trim() || null;
  if (!cmd) return;
  const parts = cmd.split(/\s+/).filter(Boolean);
  spawnChecked(
    spawn,
    parts[0]!,
    parts.slice(1),
    root,
    `testCommand failed: tests exited`,
    json,
  );
}

function readEnvelope(path: string): Envelope {
  return readDocument("envelope", path, `envelope ${path}`) as Envelope;
}

function loadManifestRecords(
  root: string,
): { recs: Record<string, ReplacementRecord>; error: SlimExit | null; missing: boolean } {
  const manPath = join(root, ".slim", "manifest.json");
  if (!existsSync(manPath)) return { recs: {}, error: null, missing: true };
  try {
    const json = readDocument("manifest", manPath, ".slim/manifest.json") as {
      replacements?: Record<string, ReplacementRecord>;
    };
    return { recs: json.replacements ?? {}, error: null, missing: false };
  } catch (err) {
    const fatal = err instanceof SlimExit ? err : new SlimExit(EXIT_FAIL, `malformed manifest ${manPath}`);
    return { recs: {}, error: fatal, missing: false };
  }
}

function originalPackageImports(root: string, files: string[], pkg: string): EnvelopeDrift[] {
  const wanted = wantedSpecifiers(pkg);
  const ts = loadTargetTypescript(root);
  const drift: EnvelopeDrift[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: import("typescript").Node): void => {
      if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        const clause = node.importClause;
        const typeOnly =
          Boolean(clause?.isTypeOnly) ||
          (clause?.namedBindings &&
            ts.isNamedImports(clause.namedBindings) &&
            !clause.name &&
            clause.namedBindings.elements.every((el) => el.isTypeOnly));
        if (!typeOnly && specifierMatches(spec, wanted) && !spec.startsWith(".") && !spec.startsWith("/")) {
          drift.push({
            kind: "import",
            detail: `${relative(root, file)} imports original package ${spec}`,
          });
        }
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const spec = node.moduleSpecifier.text;
        if (
          !node.isTypeOnly &&
          specifierMatches(spec, wanted) &&
          !spec.startsWith(".") &&
          !spec.startsWith("/")
        ) {
          drift.push({
            kind: "import",
            detail: `${relative(root, file)} re-exports original package ${spec}`,
          });
        }
      } else if (ts.isCallExpression(node)) {
        const expr = node.expression;
        const isRequire = ts.isIdentifier(expr) && expr.text === "require";
        const isImport = expr.kind === ts.SyntaxKind.ImportKeyword;
        if ((isRequire || isImport) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          const spec = node.arguments[0].text;
          if (specifierMatches(spec, wanted) && !spec.startsWith(".") && !spec.startsWith("/")) {
            drift.push({
              kind: "import",
              detail: `${relative(root, file)} loads original package ${spec}`,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return drift;
}

function missingExports(root: string, moduleRel: string | undefined, saved: Envelope): EnvelopeDrift[] {
  if (!moduleRel) return [{ kind: "exports", detail: "missing slice module" }];
  const abs = join(root, moduleRel);
  if (!existsSync(abs)) return [{ kind: "exports", detail: `missing slice module ${moduleRel}` }];
  let source: string;
  try {
    source = readFileSync(abs, "utf8");
  } catch {
    return [{ kind: "exports", detail: `unreadable slice module ${moduleRel}` }];
  }
  try {
    const ts = loadTargetTypescript(root);
    const result = checkContracts(ts, source, saved);
    return result.errors.map((detail) => ({ kind: "exports" as const, detail }));
  } catch {
    return [];
  }
}

function uniqDrift(items: EnvelopeDrift[]): EnvelopeDrift[] {
  const seen = new Set<string>();
  const out: EnvelopeDrift[] = [];
  for (const d of items) {
    const key = `${d.kind}\0${d.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

function emitDiag(args: CliArgs, line: string): void {
  process.stderr.write(line.endsWith("\n") ? line : `${line}\n`);
}

export async function runCheck(args: CliArgs, opts: RunCheckOpts = {}): Promise<number> {
  const project = loadProject(opts.cwd);
  const spawn = opts.spawn ?? spawnSync;
  const json = Boolean(args.json);
  const config = loadConfig(project.root);
  let names = Object.keys(config.replacements);
  const man = loadManifestRecords(project.root);
  if (!names.length) {
    if (man.missing) {
      const empty: CheckReport = {
        schemaVersion: JSON_SCHEMA_VERSION,
        ok: true,
        exit: EXIT_OK,
        status: "ok",
        packages: [],
      };
      if (json) {
        assertDocument("check", empty);
        writeJson(empty);
      } else process.stdout.write("no Slim replacements recorded. Run slim replace <pkg> first.\n");
      return EXIT_OK;
    }
    if (man.error) {
      if (!json) throw man.error;
    } else {
      names.push(...Object.keys(man.recs));
    }
  }
  if (args.pkg) {
    if (!names.includes(args.pkg) && !(args.pkg in man.recs)) {
      throw new SlimExit(EXIT_FAIL, `no Slim replacement recorded for ${args.pkg}`);
    }
    names = [args.pkg];
  }
  const packages: CheckPackageResult[] = [];
  let failed = false;
  if (man.error) {
    emitDiag(args, man.error.message);
    failed = true;
    if (!json) throw man.error;
  }
  for (const pkg of names) {
    const rec = man.recs[pkg];
    const state = replacementStateIssues(project.root, pkg, rec, {
      outDir: config.outDir,
      envelope: config.replacements[pkg]?.envelope,
      moduleFallback: config.replacements[pkg]?.module,
    });
    if (state.fatal && !json) throw state.fatal;
    const stateBroken = state.drift.length > 0;
    const residualRisk = state.residualRisk;
    const envPath = state.paths?.envelopeAbs ?? join(project.root, ".slim", pkg, "envelope.json");
    if (!existsSync(envPath)) {
      emitDiag(args, `missing envelope ${envPath}`);
      packages.push({
        pkg,
        ok: false,
        drift: uniqDrift(state.drift),
        unknowns: [],
        standing: "missing",
        residualRisk,
      });
      failed = true;
      continue;
    }
    let saved: Envelope;
    try {
      saved = state.envelope ?? readEnvelope(envPath);
    } catch (err) {
      const msg = err instanceof SlimExit ? err.message : `malformed envelope ${envPath}`;
      emitDiag(args, msg);
      packages.push({
        pkg,
        ok: false,
        drift: uniqDrift([{ kind: "envelope", detail: msg }, ...state.drift]),
        unknowns: [],
        standing: "missing",
        residualRisk,
      });
      failed = true;
      if (!json && err instanceof SlimExit) throw err;
      continue;
    }
    if (saved.schemaVersion != null && saved.schemaVersion !== 1) {
      const detail = `envelope schemaVersion ${String(saved.schemaVersion)} is not 1`;
      emitDiag(args, `${pkg}: ${detail}`);
      packages.push({
        pkg,
        ok: false,
        drift: uniqDrift([{ kind: "envelope", detail }, ...state.drift]),
        unknowns: [],
        standing: "missing",
        residualRisk,
      });
      failed = true;
      continue;
    }
    const moduleRel = rec?.module ?? config.replacements[pkg]?.module;
    const now = analyzePackage(project, pkg, {
      allowUnknown: args.allowUnknown,
      include: config.include,
      ignore: config.ignore,
    });
    const scanFiles = [
      moduleRel ? join(project.root, moduleRel) : "",
      standingTestPaths(project.root, pkg, config.outDir).tsAbs,
      standingTestPaths(project.root, pkg, config.outDir).jsAbs,
      ...(moduleRel
        ? [hardeningTestPaths(project.root, moduleRel).tsAbs, hardeningTestPaths(project.root, moduleRel).jsAbs]
        : []),
    ].filter(Boolean);
    const drift = uniqDrift([
      ...state.drift,
      ...diffEnvelope(saved, now),
      ...missingExports(project.root, moduleRel, saved),
      ...originalPackageImports(project.root, scanFiles, pkg),
    ]);
    const extraUnknowns = now.unknowns.filter((u) => !saved.unknowns?.some((s) => s.kind === u.kind && s.id === u.id));
    if (drift.length) {
      emitDiag(
        args,
        `${pkg}: envelope drifted (${drift.map((d) => d.detail).join("; ")}). re-run slim replace ${pkg}`,
      );
      failed = true;
    } else if (!json) {
      const namesList = (saved.symbols ?? []).map((s) => s.exportName).join(", ");
      process.stdout.write(`${pkg}: envelope unchanged (${namesList})\n`);
      if (residualRisk.length) {
        process.stdout.write(`${pkg}: residual risk: ${residualRisk.join("; ")}\n`);
      }
    }
    let standing: CheckPackageResult["standing"] = "pass";
    const hasStanding = hasStandingTests(project.root, pkg, config.outDir);
    if (!hasStanding) {
      standing = "missing";
      emitDiag(args, `${pkg}: missing standing tests`);
      failed = true;
    } else if (stateBroken) {
      standing = "fail";
      failed = true;
    } else {
      try {
        runStandingTests(project.root, pkg, config.outDir, spawn, json);
        runHardenedTests(project.root, moduleRel, spawn, json);
      } catch (err) {
        standing = "fail";
        failed = true;
        if (!json) throw err;
        if (err instanceof SlimExit) emitDiag(args, err.message);
      }
    }
    const ok = drift.length === 0 && extraUnknowns.length === 0 && standing === "pass";
    if (!ok) failed = true;
    packages.push({
      pkg,
      ok,
      drift,
      unknowns: extraUnknowns.map((u) => u.kind),
      standing,
      residualRisk,
    });
  }
  if (!names.length) {
    if (json) {
      const report: CheckReport = {
        schemaVersion: JSON_SCHEMA_VERSION,
        ok: !failed,
        exit: failed ? EXIT_FAIL : EXIT_OK,
        status: statusFromExit(failed ? EXIT_FAIL : EXIT_OK),
        packages,
      };
      assertDocument("check", report);
      writeJson(report);
    }
    if (failed) throw new SlimExit(EXIT_FAIL, "slim check failed", { skipJson: json });
    return EXIT_OK;
  }
  try {
    runConfiguredTestCommand(project.root, config.testCommand, spawn, json);
  } catch (err) {
    failed = true;
    if (!json) throw err;
    if (err instanceof SlimExit) emitDiag(args, err.message);
  }
  const exit = failed ? EXIT_FAIL : EXIT_OK;
  const report: CheckReport = {
    schemaVersion: JSON_SCHEMA_VERSION,
    ok: !failed,
    exit,
    status: statusFromExit(exit),
    packages,
  };
  if (json) {
    assertDocument("check", report);
    writeJson(report);
  }
  if (failed) throw new SlimExit(EXIT_FAIL, "slim check failed", { skipJson: json });
  return EXIT_OK;
}
