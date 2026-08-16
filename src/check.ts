import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { CliArgs } from "./cli.ts";
import { EXIT_FAIL, EXIT_OK, SlimExit } from "./exit.ts";
import { loadProject } from "./project.ts";
import { loadConfig } from "./config.ts";
import { analyzePackage } from "./analyze/index.ts";
import { withLocalBinPath } from "./replace.ts";

export type CheckSpawn = (
  command: string,
  args?: readonly string[],
  options?: SpawnSyncOptions,
) => Pick<SpawnSyncReturns<string | Buffer>, "status">;

export interface RunCheckOpts {
  cwd?: string;
  spawn?: CheckSpawn;
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

export function runStandingTests(
  root: string,
  pkg: string,
  outDir: string,
  spawn: CheckSpawn = spawnSync,
): void {
  const pkgPath = join(root, "package.json");
  let evidence: string | null = null;
  if (existsSync(pkgPath)) {
    try {
      const json = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      evidence = json.scripts?.["slim:evidence"]?.trim() || null;
    } catch {
      evidence = null;
    }
  }
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
  const stem = `${pkg.replace(/\//g, "-")}.test`;
  const tsRel = join(outDir, `${stem}.ts`);
  const jsRel = join(outDir, `${stem}.js`);
  const tsAbs = join(root, tsRel);
  const jsAbs = join(root, jsRel);
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

export async function runCheck(args: CliArgs, opts: RunCheckOpts = {}): Promise<number> {
  const project = loadProject(opts.cwd);
  const spawn = opts.spawn ?? spawnSync;
  const config = loadConfig(project.root);
  const names = Object.keys(config.replacements);
  if (!names.length) {
    const man = join(project.root, ".slim", "manifest.json");
    if (!existsSync(man)) {
      process.stdout.write("no Slim replacements recorded. Run slim replace <pkg> first.\n");
      return EXIT_OK;
    }
    const json = JSON.parse(readFileSync(man, "utf8")) as {
      replacements?: Record<string, unknown>;
    };
    names.push(...Object.keys(json.replacements ?? {}));
  }
  let failed = false;
  for (const pkg of names) {
    const envPath = resolveEnvelopePath(project.root, pkg, config.replacements[pkg]?.envelope);
    if (!existsSync(envPath)) {
      process.stderr.write(`missing envelope ${envPath}\n`);
      failed = true;
      continue;
    }
    const saved = JSON.parse(readFileSync(envPath, "utf8")) as {
      symbols: Array<{ exportName: string }>;
    };
    const savedNames = new Set(saved.symbols.map((s) => s.exportName));
    const now = analyzePackage(project, pkg, {
      allowUnknown: args.allowUnknown,
      include: config.include,
      ignore: config.ignore,
    });
    const grew = now.symbols.filter((s) => !savedNames.has(s.exportName) && s.exportName !== "*");
    const extraUnknowns = now.unknowns.filter((u) => u.widensTo === "refuse");
    if (args.json) {
      process.stdout.write(
        JSON.stringify({
          pkg,
          grew: grew.map((s) => s.exportName),
          unknowns: extraUnknowns.map((u) => u.kind),
        }) + "\n",
      );
    }
    if (grew.length) {
      process.stderr.write(
        `${pkg}: envelope grew (${grew.map((s) => s.exportName).join(", ")}). re-run slim replace ${pkg}\n`,
      );
      failed = true;
    } else if (!args.json) {
      process.stdout.write(`${pkg}: envelope unchanged (${[...savedNames].join(", ")})\n`);
    }
    if (extraUnknowns.length) {
      process.stderr.write(`${pkg}: new refuse-level unknowns\n`);
      failed = true;
    }
    runStandingTests(project.root, pkg, config.outDir, spawn);
  }
  if (!names.length) return EXIT_OK;
  runConfiguredTestCommand(project.root, config.testCommand, spawn);
  if (failed) throw new SlimExit(EXIT_FAIL, "slim check failed");
  return EXIT_OK;
}
