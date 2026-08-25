import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyRevert, type RevertPlan } from "../src/rewrite/revert.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function runSlim(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, CI: "1" };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(ROOT, "src/main.ts"), ...args],
    { cwd, encoding: "utf8", env, timeout: 180_000 },
  );
}

function copyMs(dest: string): void {
  cpSync(join(ROOT, "fixtures", "ms-parse"), dest, {
    recursive: true,
    filter: (p) => {
      const rel = relative(join(ROOT, "fixtures", "ms-parse"), p);
      if (!rel || rel === ".") return true;
      if (rel.split(/[/\\]/)[0] === "node_modules") return false;
      if (rel.startsWith("src/slim") || rel.startsWith(".slim")) return false;
      return true;
    },
  });
}

function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out[relative(root, p).replace(/\\/g, "/")] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}

function npmInstall(cwd: string): void {
  const r = spawnSync("npm", ["install", "--ignore-scripts"], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stderr);
}

test("dry-run with traces leaves the project byte-identical", { timeout: 180_000 }, () => {
  const dest = mkdtempSync(join(tmpdir(), "slim-dry-"));
  copyMs(dest);
  npmInstall(dest);
  const before = snapshotTree(dest);
  const r = runSlim(dest, ["replace", "ms", "--dry-run", "--no-pr", "--budget-ms", "800"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const after = snapshotTree(dest);
  assert.deepEqual(after, before);
  assert.equal(existsSync(join(dest, "src", "slim", "ms.ts")), false);
});

test("merge-gate failure restores the project", { timeout: 180_000 }, () => {
  const dest = mkdtempSync(join(tmpdir(), "slim-gate-"));
  copyMs(dest);
  writeFileSync(join(dest, "fail.js"), "process.exit(1);\n");
  const pkgPath = join(dest, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
  pkg.scripts = { ...(pkg.scripts ?? {}), test: "node fail.js" };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  npmInstall(dest);
  const before = snapshotTree(dest);
  const r = runSlim(dest, [
    "replace",
    "ms",
    "--no-pr",
    "--no-trace",
    "--no-install",
    "--budget-ms",
    "800",
    "--workers",
    "1",
  ]);
  assert.notEqual(r.status, 0, "merge gate should fail");
  const after = snapshotTree(dest);
  assert.deepEqual(after, before);
  assert.equal(existsSync(join(dest, "src", "slim", "ms.ts")), false);
});

test("lockfile refresh failure restores package.json and does not write evidence", { timeout: 180_000 }, () => {
  const dest = mkdtempSync(join(tmpdir(), "slim-lf-fail-"));
  copyMs(dest);
  npmInstall(dest);
  const fake = join(dest, ".fake-bin");
  mkdirSync(fake);
  writeFileSync(join(fake, "npm"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(fake, "npm"), 0o755);
  const before = snapshotTree(dest);
  const r = runSlim(
    dest,
    ["replace", "ms", "--no-pr", "--no-trace", "--budget-ms", "800", "--workers", "1"],
    { PATH: `${fake}:${process.env.PATH ?? ""}` },
  );
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /lockfile refresh failed/i);
  const after = snapshotTree(dest);
  assert.equal(after["package.json"], before["package.json"]);
  assert.equal(existsSync(join(dest, ".slim", "ms", "evidence.md")), false);
  assert.equal(existsSync(join(dest, "src", "slim", "ms.ts")), false);
});

test("--keep-original leaves the dependency in package.json", { timeout: 180_000 }, () => {
  const dest = mkdtempSync(join(tmpdir(), "slim-keep-"));
  copyMs(dest);
  npmInstall(dest);
  const r = runSlim(dest, [
    "replace",
    "ms",
    "--no-pr",
    "--no-trace",
    "--keep-original",
    "--budget-ms",
    "800",
    "--workers",
    "1",
  ]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const pkg = JSON.parse(readFileSync(join(dest, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(pkg.dependencies?.ms, "2.1.3");
  assert.ok(existsSync(join(dest, "src", "slim", "ms.ts")));
});

test("second replace --no-install is idempotent for source and package.json", { timeout: 180_000 }, () => {
  const dest = mkdtempSync(join(tmpdir(), "slim-idemp-"));
  copyMs(dest);
  npmInstall(dest);
  const args = [
    "replace",
    "ms",
    "--no-pr",
    "--no-trace",
    "--no-install",
    "--budget-ms",
    "800",
    "--workers",
    "1",
    "--seed",
    "1",
  ];
  const a = runSlim(dest, args);
  assert.equal(a.status, 0, a.stderr + a.stdout);
  const first = {
    pkg: readFileSync(join(dest, "package.json"), "utf8"),
    slice: readFileSync(join(dest, "src", "slim", "ms.ts"), "utf8"),
    index: readFileSync(join(dest, "src", "index.ts"), "utf8"),
    standing: readFileSync(join(dest, "src", "slim", "ms.test.ts"), "utf8"),
    envelope: readFileSync(join(dest, ".slim", "ms", "envelope.json"), "utf8"),
    slimJson: readFileSync(join(dest, "slim.json"), "utf8"),
    manifest: readFileSync(join(dest, ".slim", "manifest.json"), "utf8"),
  };
  const b = runSlim(dest, args);
  assert.equal(b.status, 0, b.stderr + b.stdout);
  assert.equal(readFileSync(join(dest, "package.json"), "utf8"), first.pkg);
  assert.equal(readFileSync(join(dest, "src", "slim", "ms.ts"), "utf8"), first.slice);
  assert.equal(readFileSync(join(dest, "src", "index.ts"), "utf8"), first.index);
  assert.equal(readFileSync(join(dest, "src", "slim", "ms.test.ts"), "utf8"), first.standing);
  assert.equal(readFileSync(join(dest, ".slim", "ms", "envelope.json"), "utf8"), first.envelope);
  assert.equal(readFileSync(join(dest, "slim.json"), "utf8"), first.slimJson);
  assert.equal(readFileSync(join(dest, ".slim", "manifest.json"), "utf8"), first.manifest);
  const c1 = runSlim(dest, ["check"]);
  const c2 = runSlim(dest, ["check"]);
  assert.equal(c1.status, 0, c1.stderr);
  assert.equal(c2.status, 0, c2.stderr);
});

test("applyRevert after replace restores imports and the dependency", { timeout: 180_000 }, () => {
  const dest = mkdtempSync(join(tmpdir(), "slim-rev-"));
  copyMs(dest);
  npmInstall(dest);
  const indexBefore = readFileSync(join(dest, "src", "index.ts"), "utf8");
  const r = runSlim(dest, [
    "replace",
    "ms",
    "--no-pr",
    "--no-trace",
    "--no-install",
    "--budget-ms",
    "800",
    "--workers",
    "1",
  ]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const evidence = JSON.parse(readFileSync(join(dest, ".slim", "ms", "evidence.json"), "utf8")) as {
    revert: RevertPlan;
  };
  applyRevert(dest, evidence.revert);
  assert.match(readFileSync(join(dest, "src", "index.ts"), "utf8"), /from ["']ms["']/);
  assert.equal(readFileSync(join(dest, "src", "index.ts"), "utf8"), indexBefore);
  const pkg = JSON.parse(readFileSync(join(dest, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(pkg.dependencies?.ms, "2.1.3");
  assert.equal(existsSync(join(dest, "src", "slim", "ms.ts")), false);
});

test("replacing lodash does not remove unused lodash-es", { timeout: 180_000 }, () => {
  const dest = mkdtempSync(join(tmpdir(), "slim-sib-"));
  copyMs(dest);
  const pkgPath = join(dest, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  pkg.dependencies = { lodash: "4.17.21", "lodash-es": "4.17.21" };
  pkg.scripts = {
    ...(pkg.scripts ?? {}),
    test: "node --experimental-strip-types --test src/index.test.ts",
  };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  writeFileSync(
    join(dest, "src", "index.ts"),
    `import { get } from "lodash";\nexport const n = get({ a: 1 }, "a");\n`,
  );
  writeFileSync(
    join(dest, "src", "index.test.ts"),
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { n } from "./index.ts";\ntest("n", () => assert.equal(n, 1));\n`,
  );
  npmInstall(dest);
  const r = runSlim(dest, [
    "replace",
    "lodash",
    "--no-pr",
    "--no-trace",
    "--no-install",
    "--budget-ms",
    "800",
    "--workers",
    "1",
  ]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const after = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string> };
  assert.equal(after.dependencies?.lodash, undefined);
  assert.equal(after.dependencies?.["lodash-es"], "4.17.21");
  rmSync(dest, { recursive: true, force: true });
});

test("no tmp.mjs remains under the project after replace", { timeout: 180_000 }, () => {
  const dest = mkdtempSync(join(tmpdir(), "slim-tmp-"));
  copyMs(dest);
  npmInstall(dest);
  const r = runSlim(dest, [
    "replace",
    "ms",
    "--no-pr",
    "--no-trace",
    "--no-install",
    "--budget-ms",
    "800",
    "--workers",
    "1",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const leftovers: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".tmp.mjs")) leftovers.push(p);
    }
  };
  walk(dest);
  assert.deepEqual(leftovers, []);
});
