import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { CliArgs } from "./cli.ts";
import { EXIT_FAIL, EXIT_OK, SlimExit } from "./exit.ts";
import { loadProject, loadTargetTypescript } from "./project.ts";
import { loadConfig } from "./config.ts";
import { analyzePackage } from "./analyze/index.ts";
import { withLocalBinPath } from "./replace.ts";
import { JSON_SCHEMA_VERSION, statusFromExit, writeJson } from "./json.ts";
import { assertDocument, readDocument } from "./schema/documents.ts";
import { diffEnvelope, type EnvelopeDrift } from "./envelope/drift.ts";
import { hashEnvelope, type Envelope } from "./envelope/types.ts";
import { checkContracts } from "./generate/exports.ts";

export type CheckSpawn = (
  command: string,
  args?: readonly string[],
  options?: SpawnSyncOptions,
) => Pick<SpawnSyncReturns<string | Buffer>, "status">;

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

function resolveEnvelopePath(root: string, pkg: string, configured?: string): string {
  const raw = configured?.trim() || join(".slim", pkg, "envelope.json");
  return isAbsolute(raw) ? raw : join(root, raw);
}

function spawnChecked(
  spawn: CheckSpawn,
  command: string,
  args: string[],
  root: string,
  failMessage: string,
): void {
  const r = spawn(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    env: withLocalBinPath(root),
  });
  if (r.status !== 0) {
    throw new SlimExit(EXIT_FAIL, failMessage);
  }
}

export function standingTestPaths(
  root: string,
  pkg: string,
  outDir: string,
): { tsRel: string; jsRel: string; tsAbs: string; jsAbs: string } {
  const stem = `${pkg.replace(/\//g, "-")}.test`;
  const tsRel = join(outDir, `${stem}.ts`);
  const jsRel = join(outDir, `${stem}.js`);
  return { tsRel, jsRel, tsAbs: join(root, tsRel), jsAbs: join(root, jsRel) };
}

export function evidenceScript(root: string): string | null {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const json = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    return json.scripts?.["slim:evidence"]?.trim() || null;
  } catch {
    return null;
  }
}

export function runStandingTests(
  root: string,
  pkg: string,
  outDir: string,
  spawn: CheckSpawn = spawnSync,
): void {
  const evidence = evidenceScript(root);
  if (evidence) {
    const parts = evidence.split(/\s+/).filter(Boolean);
    spawnChecked(
      spawn,
      parts[0]!,
      parts.slice(1),
      root,
      `standing tests failed for ${pkg}`,
    );
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
    );
    return;
  }
  if (existsSync(jsAbs)) {
    spawnChecked(
      spawn,
      process.execPath,
      ["--test", jsRel],
      root,
      `standing tests failed for ${pkg}`,
    );
  }
}

export function runHardenedTests(
  root: string,
  moduleRel: string | undefined,
  spawn: CheckSpawn = spawnSync,
): void {
  if (!moduleRel) return;
  const base = moduleRel.replace(/\.(ts|js|mjs|cjs)$/, "");
  const tsRel = `${base}.hardened.test.ts`;
  const jsRel = `${base}.hardened.test.js`;
  const tsAbs = join(root, tsRel);
  const jsAbs = join(root, jsRel);
  if (existsSync(tsAbs)) {
    spawnChecked(
      spawn,
      process.execPath,
      ["--experimental-strip-types", "--test", tsRel],
      root,
      `hardening tests failed for ${moduleRel}`,
    );
    return;
  }
  if (existsSync(jsAbs)) {
    spawnChecked(spawn, process.execPath, ["--test", jsRel], root, `hardening tests failed for ${moduleRel}`);
  }
}

export function runConfiguredTestCommand(
  root: string,
  testCommand: string | null,
  spawn: CheckSpawn = spawnSync,
): void {
  const cmd = testCommand?.trim() || null;
  if (!cmd) return;
  const parts = cmd.split(/\s+/).filter(Boolean);
  const r = spawn(parts[0]!, parts.slice(1), {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    env: withLocalBinPath(root),
  });
  if (r.status !== 0) {
    throw new SlimExit(EXIT_FAIL, `testCommand failed: tests exited ${r.status ?? "signal"}`);
  }
}

function residualRiskFor(root: string, pkg: string): string[] {
  const p = join(root, ".slim", pkg, "evidence.json");
  if (!existsSync(p)) return [];
  const json = readDocument("evidence", p, "evidence.json") as { residualRisk?: unknown };
  return Array.isArray(json.residualRisk) ? json.residualRisk.map(String) : [];
}

function readEnvelope(path: string): Envelope {
  return readDocument("envelope", path, `envelope ${path}`) as Envelope;
}

function hashMismatches(root: string, pkg: string, saved: Envelope): EnvelopeDrift[] {
  const drift: EnvelopeDrift[] = [];
  let expected: string;
  try {
    expected = hashEnvelope(saved);
  } catch {
    return drift;
  }
  const evidencePath = join(root, ".slim", pkg, "evidence.json");
  if (existsSync(evidencePath)) {
    const ev = readDocument("evidence", evidencePath) as { envelopeHash?: string };
    if (ev.envelopeHash && ev.envelopeHash !== expected) {
      drift.push({ kind: "hash", detail: "evidence.json envelopeHash does not match envelope" });
    }
  }
  const manPath = join(root, ".slim", "manifest.json");
  if (existsSync(manPath)) {
    const man = readDocument("manifest", manPath) as {
      replacements?: Record<string, { envelopeHash?: string; version?: string }>;
    };
    const rec = man.replacements?.[pkg];
    if (rec?.envelopeHash && rec.envelopeHash !== expected) {
      drift.push({ kind: "hash", detail: "manifest envelopeHash does not match envelope" });
    }
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

export async function runCheck(args: CliArgs, opts: RunCheckOpts = {}): Promise<number> {
  const project = loadProject(opts.cwd);
  const spawn = opts.spawn ?? spawnSync;
  const config = loadConfig(project.root);
  let names = Object.keys(config.replacements);
  if (!names.length) {
    const man = join(project.root, ".slim", "manifest.json");
    if (!existsSync(man)) {
      const empty: CheckReport = {
        schemaVersion: JSON_SCHEMA_VERSION,
        ok: true,
        exit: EXIT_OK,
        status: "ok",
        packages: [],
      };
      if (args.json) {
        assertDocument("check", empty);
        writeJson(empty);
      }
      else process.stdout.write("no Slim replacements recorded. Run slim replace <pkg> first.\n");
      return EXIT_OK;
    }
    const json = readDocument("manifest", man, ".slim/manifest.json") as {
      replacements?: Record<string, unknown>;
    };
    names.push(...Object.keys(json.replacements ?? {}));
  }
  if (args.pkg) {
    if (!names.includes(args.pkg)) {
      throw new SlimExit(EXIT_FAIL, `no Slim replacement recorded for ${args.pkg}`);
    }
    names = [args.pkg];
  }
  const packages: CheckPackageResult[] = [];
  let failed = false;
  for (const pkg of names) {
    const envPath = resolveEnvelopePath(project.root, pkg, config.replacements[pkg]?.envelope);
    const residualRisk = residualRiskFor(project.root, pkg);
    if (!existsSync(envPath)) {
      process.stderr.write(`missing envelope ${envPath}\n`);
      packages.push({
        pkg,
        ok: false,
        drift: [{ kind: "envelope", detail: `missing envelope ${envPath}` }],
        unknowns: [],
        standing: "missing",
        residualRisk,
      });
      failed = true;
      continue;
    }
    let saved: Envelope;
    try {
      saved = readEnvelope(envPath);
    } catch (err) {
      const msg = err instanceof SlimExit ? err.message : `malformed envelope ${envPath}`;
      process.stderr.write(`${msg}\n`);
      packages.push({
        pkg,
        ok: false,
        drift: [{ kind: "envelope", detail: msg }],
        unknowns: [],
        standing: "missing",
        residualRisk,
      });
      failed = true;
      if (!args.json && err instanceof SlimExit) throw err;
      continue;
    }
    if (saved.schemaVersion != null && saved.schemaVersion !== 1) {
      const detail = `envelope schemaVersion ${String(saved.schemaVersion)} is not 1`;
      process.stderr.write(`${pkg}: ${detail}\n`);
      packages.push({
        pkg,
        ok: false,
        drift: [{ kind: "envelope", detail }],
        unknowns: [],
        standing: "missing",
        residualRisk,
      });
      failed = true;
      continue;
    }
    const now = analyzePackage(project, pkg, {
      allowUnknown: args.allowUnknown,
      include: config.include,
      ignore: config.ignore,
    });
    const drift = [
      ...diffEnvelope(saved, now),
      ...hashMismatches(project.root, pkg, saved),
      ...missingExports(project.root, config.replacements[pkg]?.module, saved),
    ];
    const configuredVersion = config.replacements[pkg]?.version;
    if (configuredVersion && saved.package?.version && configuredVersion !== saved.package.version) {
      drift.push({
        kind: "version",
        detail: `slim.json version ${configuredVersion} != envelope ${saved.package.version}`,
      });
    }
    const extraUnknowns = now.unknowns.filter((u) => !saved.unknowns?.some((s) => s.kind === u.kind && s.id === u.id));
    if (drift.length) {
      process.stderr.write(
        `${pkg}: envelope drifted (${drift.map((d) => d.detail).join("; ")}). re-run slim replace ${pkg}\n`,
      );
      failed = true;
    } else if (!args.json) {
      const namesList = (saved.symbols ?? []).map((s) => s.exportName).join(", ");
      process.stdout.write(`${pkg}: envelope unchanged (${namesList})\n`);
      if (residualRisk.length) {
        process.stdout.write(`${pkg}: residual risk: ${residualRisk.join("; ")}\n`);
      }
    }
    let standing: CheckPackageResult["standing"] = "pass";
    const evidence = evidenceScript(project.root);
    const paths = standingTestPaths(project.root, pkg, config.outDir);
    const hasStanding = Boolean(evidence) || existsSync(paths.tsAbs) || existsSync(paths.jsAbs);
    if (!hasStanding) {
      standing = "missing";
      process.stderr.write(`${pkg}: missing standing tests\n`);
      failed = true;
    } else {
      try {
        runStandingTests(project.root, pkg, config.outDir, spawn);
        runHardenedTests(project.root, config.replacements[pkg]?.module, spawn);
      } catch (err) {
        standing = "fail";
        failed = true;
        if (!args.json) throw err;
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
  if (!names.length) return EXIT_OK;
  try {
    runConfiguredTestCommand(project.root, config.testCommand, spawn);
  } catch (err) {
    failed = true;
    if (!args.json) throw err;
  }
  const exit = failed ? EXIT_FAIL : EXIT_OK;
  const report: CheckReport = {
    schemaVersion: JSON_SCHEMA_VERSION,
    ok: !failed,
    exit,
    status: statusFromExit(exit),
    packages,
  };
  if (args.json) {
    assertDocument("check", report);
    writeJson(report);
  }
  if (failed) throw new SlimExit(EXIT_FAIL, "slim check failed", { skipJson: args.json });
  return EXIT_OK;
}
