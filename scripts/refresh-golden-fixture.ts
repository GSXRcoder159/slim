#!/usr/bin/env node
/**
 * Restore lodash in a temp copy of the golden fixture, run `slim replace`,
 * and copy envelope / evidence / slice / package.json back.
 * traces.jsonl stays gitignored.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO, "fixtures", "lodash-get-debounce");

function run(file: string, args: string[], cwd: string): void {
  const r = spawnSync(file, args, { cwd, stdio: "inherit", encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${file} ${args.join(" ")} exited ${r.status}`);
  }
}

function copyIfExists(from: string, to: string): void {
  if (!existsSync(from)) throw new Error(`missing ${from}`);
  cpSync(from, to);
}

const tmp = mkdtempSync(join(tmpdir(), "slim-golden-"));
try {
  cpSync(FIXTURE, tmp, {
    recursive: true,
    filter: (src) => !src.includes("node_modules") && !src.endsWith("traces.jsonl"),
  });

  const indexPath = join(tmp, "src", "index.ts");
  const index = readFileSync(indexPath, "utf8").replace(
    /from ["']\.\/slim\/lodash\.ts["']/,
    `from "lodash"`,
  );
  writeFileSync(indexPath, index);

  const pkgPath = join(tmp, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  pkg.dependencies = { ...(pkg.dependencies ?? {}), lodash: "4.17.21" };
  pkg.devDependencies = {
    ...(pkg.devDependencies ?? {}),
    typescript: pkg.devDependencies?.typescript ?? "^5.9.2",
    "@cloudflare/workers-types":
      pkg.devDependencies?.["@cloudflare/workers-types"] ?? "^4.20250813.0",
  };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  run("npm", ["install", "--no-audit", "--no-fund"], tmp);
  run(
    process.execPath,
    [
      "--experimental-strip-types",
      join(REPO, "src", "main.ts"),
      "replace",
      "lodash",
      "--no-pr",
      "--no-install",
      "--seed",
      "1",
      "--budget-ms",
      "30000",
    ],
    tmp,
  );

  const slimDir = join(FIXTURE, ".slim", "lodash");
  copyIfExists(join(tmp, ".slim", "lodash", "envelope.json"), join(slimDir, "envelope.json"));
  copyIfExists(join(tmp, ".slim", "lodash", "evidence.md"), join(slimDir, "evidence.md"));
  copyIfExists(join(tmp, ".slim", "lodash", "evidence.json"), join(slimDir, "evidence.json"));
  copyIfExists(join(tmp, ".slim", "lodash", "traces.meta.json"), join(slimDir, "traces.meta.json"));
  copyIfExists(join(tmp, "src", "slim", "lodash.ts"), join(FIXTURE, "src", "slim", "lodash.ts"));
  copyIfExists(join(tmp, "src", "slim", "lodash.test.ts"), join(FIXTURE, "src", "slim", "lodash.test.ts"));
  copyIfExists(join(tmp, "src", "index.ts"), join(FIXTURE, "src", "index.ts"));
  copyIfExists(join(tmp, "package.json"), join(FIXTURE, "package.json"));
  copyIfExists(join(tmp, "slim.json"), join(FIXTURE, "slim.json"));
  if (existsSync(join(tmp, ".slim", "manifest.json"))) {
    copyIfExists(join(tmp, ".slim", "manifest.json"), join(FIXTURE, ".slim", "manifest.json"));
  }

  const evidence = JSON.parse(readFileSync(join(slimDir, "evidence.json"), "utf8")) as {
    fuzz: { tracesReplayed: number };
  };
  const envelope = JSON.parse(readFileSync(join(slimDir, "envelope.json"), "utf8")) as {
    env: string[];
    symbols: Array<{ coverage: { callSitesTraced: number } }>;
  };
  if (evidence.fuzz.tracesReplayed < 1) {
    throw new Error(`refresh produced tracesReplayed=${evidence.fuzz.tracesReplayed}`);
  }
  if (!envelope.env.includes("worker")) {
    throw new Error(`refresh envelope env=${envelope.env.join(",")} missing worker`);
  }
  if (!envelope.symbols.some((s) => s.coverage.callSitesTraced > 0)) {
    throw new Error("refresh envelope has zero callSitesTraced");
  }
  process.stdout.write(
    `refreshed golden fixture tracesReplayed=${evidence.fuzz.tracesReplayed} env=${envelope.env.join(",")}\n`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
