import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyRevert, type RevertPlan } from "../src/rewrite/revert.ts";
import { hermeticPmEnv, spawnPm } from "../src/rewrite/lockfile.ts";
import { packSlim } from "./helpers/llm-replace.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function runSlim(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const env = hermeticPmEnv({ ...extraEnv });
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
      if (rel.replace(/\\/g, "/").startsWith("src/slim") || rel.replace(/\\/g, "/").startsWith(".slim"))
        return false;
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
      const st = lstatSync(p);
      const rel = relative(root, p).replace(/\\/g, "/");
      if (st.isSymbolicLink()) out[rel] = `symlink:${readlinkSync(p)}`;
      else if (st.isDirectory()) walk(p);
      else if (st.isFile()) out[rel] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}

function npmInstall(cwd: string): void {
  const r = spawnPm("npm", ["install", "--ignore-scripts"], {
    cwd,
    encoding: "utf8",
    env: hermeticPmEnv(),
    timeout: 120_000,
  });
  assert.equal(r.status, 0, String(r.stderr));
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
  if (process.platform === "win32") {
    writeFileSync(join(fake, "npm.cmd"), "@echo off\r\nexit /b 1\r\n");
  } else {
    writeFileSync(join(fake, "npm"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(fake, "npm"), 0o755);
  }
  const before = snapshotTree(dest);
  const r = runSlim(
    dest,
    ["replace", "ms", "--no-pr", "--no-trace", "--budget-ms", "800", "--workers", "1"],
    { PATH: `${fake}${delimiter}${process.env.PATH ?? ""}` },
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
      if (lstatSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".tmp.mjs")) leftovers.push(p);
    }
  };
  walk(dest);
  assert.deepEqual(leftovers, []);
});

test("dry-run leaves git status and file kinds unchanged", { timeout: 180_000 }, () => {
  const dest = mkdtempSync(join(tmpdir(), "slim-dry-git-"));
  copyMs(dest);
  npmInstall(dest);
  execFileSync("git", ["init", "--template=", "-b", "main"], { cwd: dest, encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "slim@test"], { cwd: dest, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "slim"], { cwd: dest, encoding: "utf8" });
  execFileSync("git", ["add", "-A"], { cwd: dest, encoding: "utf8" });
  execFileSync("git", ["commit", "-m", "init", "--no-verify"], { cwd: dest, encoding: "utf8" });
  const before = snapshotTree(dest);
  const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: dest, encoding: "utf8" });
  const r = runSlim(dest, ["replace", "ms", "--dry-run", "--no-pr", "--budget-ms", "800"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(snapshotTree(dest), before);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dest, encoding: "utf8" }), porcelain);
});

test("escaping source symlink refuses replace without mutating the target", { timeout: 180_000 }, () => {
  const dest = mkdtempSync(join(tmpdir(), "slim-esc-"));
  const outside = mkdtempSync(join(tmpdir(), "slim-esc-out-"));
  copyMs(dest);
  const secret = join(outside, "secret.ts");
  writeFileSync(secret, 'import ms from "ms";\nexport const n = ms("1h");\n');
  symlinkSync(secret, join(dest, "src", "leak.ts"));
  npmInstall(dest);
  const before = snapshotTree(dest);
  const secretBefore = readFileSync(secret, "utf8");
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
  assert.notEqual(r.status, 0, "escaping symlink must refuse");
  assert.match(`${r.stderr}${r.stdout}`, /unsafe write|escapes the project/i);
  assert.deepEqual(snapshotTree(dest), before);
  assert.equal(readFileSync(secret, "utf8"), secretBefore);
  assert.equal(lstatSync(join(dest, "src", "leak.ts")).isSymbolicLink(), true);
});

test("existing src/slim/ms.ts without a manifest is refused and left unchanged", { timeout: 180_000 }, () => {
  const dest = mkdtempSync(join(tmpdir(), "slim-unowned-"));
  copyMs(dest);
  mkdirSync(join(dest, "src", "slim"), { recursive: true });
  const slimPath = join(dest, "src", "slim", "ms.ts");
  writeFileSync(slimPath, "unrelated hand-written slice\n");
  npmInstall(dest);
  const before = snapshotTree(dest);
  const r = runSlim(dest, ["replace", "ms", "--no-pr", "--no-trace", "--no-install"]);
  assert.notEqual(r.status, 0, "unowned output must refuse");
  assert.match(`${r.stderr}${r.stdout}`, /collision/i);
  assert.equal(readFileSync(slimPath, "utf8"), "unrelated hand-written slice\n");
  assert.deepEqual(snapshotTree(dest), before);
  assert.equal(existsSync(join(dest, ".slim")), false);
});

test("internal symlinked src/slim is refused before any write", { timeout: 180_000 }, () => {
  const dest = mkdtempSync(join(tmpdir(), "slim-out-int-"));
  copyMs(dest);
  mkdirSync(join(dest, "elsewhere"), { recursive: true });
  writeFileSync(join(dest, "elsewhere", "keep.txt"), "keep\n");
  mkdirSync(join(dest, "src"), { recursive: true });
  symlinkSync(join(dest, "elsewhere"), join(dest, "src", "slim"));
  npmInstall(dest);
  const before = snapshotTree(dest);
  const r = runSlim(dest, ["replace", "ms", "--no-pr", "--no-trace", "--no-install"]);
  assert.notEqual(r.status, 0, "internal out symlink must refuse");
  assert.match(`${r.stderr}${r.stdout}`, /symlink/i);
  assert.deepEqual(snapshotTree(dest), before);
  assert.equal(lstatSync(join(dest, "src", "slim")).isSymbolicLink(), true);
  assert.equal(readFileSync(join(dest, "elsewhere", "keep.txt"), "utf8"), "keep\n");
});

test("packed CLI refuses unowned output and an internal symlinked --out", { timeout: 180_000 }, () => {
  const { tarball } = packSlim();
  const host = mkdtempSync(join(tmpdir(), "slim-phase8-host-"));
  writeFileSync(join(host, "package.json"), JSON.stringify({ name: "host", private: true, type: "module" }));
  const installed = spawnPm("npm", ["install", tarball, "--omit=dev"], {
    cwd: host,
    encoding: "utf8",
    env: hermeticPmEnv(),
    timeout: 120_000,
  });
  assert.equal(installed.status, 0, String(installed.stderr));
  const slimJs = join(host, "node_modules", "slim", "dist", "main.js");
  const runPacked = (cwd: string) =>
    spawnSync(process.execPath, [slimJs, "replace", "ms", "--no-pr", "--no-trace", "--no-install"], {
      cwd,
      encoding: "utf8",
      env: hermeticPmEnv(),
      timeout: 180_000,
    });

  const unowned = mkdtempSync(join(tmpdir(), "slim-pack-unowned-"));
  copyMs(unowned);
  mkdirSync(join(unowned, "src", "slim"), { recursive: true });
  writeFileSync(join(unowned, "src", "slim", "ms.ts"), "unrelated packed\n");
  npmInstall(unowned);
  const unownedBefore = snapshotTree(unowned);
  const unownedRun = runPacked(unowned);
  assert.notEqual(unownedRun.status, 0, unownedRun.stderr + unownedRun.stdout);
  assert.match(`${unownedRun.stderr}${unownedRun.stdout}`, /collision/i);
  assert.equal(readFileSync(join(unowned, "src", "slim", "ms.ts"), "utf8"), "unrelated packed\n");
  assert.deepEqual(snapshotTree(unowned), unownedBefore);

  const linked = mkdtempSync(join(tmpdir(), "slim-pack-out-"));
  copyMs(linked);
  mkdirSync(join(linked, "elsewhere"), { recursive: true });
  writeFileSync(join(linked, "elsewhere", "keep.txt"), "keep packed\n");
  mkdirSync(join(linked, "src"), { recursive: true });
  symlinkSync(join(linked, "elsewhere"), join(linked, "src", "slim"));
  npmInstall(linked);
  const linkedBefore = snapshotTree(linked);
  const linkedRun = runPacked(linked);
  assert.notEqual(linkedRun.status, 0, linkedRun.stderr + linkedRun.stdout);
  assert.match(`${linkedRun.stderr}${linkedRun.stdout}`, /symlink/i);
  assert.deepEqual(snapshotTree(linked), linkedBefore);
  assert.equal(readFileSync(join(linked, "elsewhere", "keep.txt"), "utf8"), "keep packed\n");
});

test("injected failure after each mutation step restores the project", { timeout: 600_000 }, () => {
  const steps = [
    "after-slice",
    "after-rewrites",
    "after-lockfile",
    "after-evidence",
    "after-standing",
    "after-manifest",
  ];
  for (const step of steps) {
    const dest = mkdtempSync(join(tmpdir(), `slim-inj-${step}-`));
    copyMs(dest);
    npmInstall(dest);
    const before = snapshotTree(dest);
    const r = runSlim(
      dest,
      [
        "replace",
        "ms",
        "--no-pr",
        "--no-trace",
        "--no-install",
        "--budget-ms",
        "800",
        "--workers",
        "1",
      ],
      { SLIM_INJECT_FAIL: step },
    );
    assert.notEqual(r.status, 0, step);
    assert.match(r.stderr, new RegExp(`injected failure: ${step}`));
    assert.deepEqual(snapshotTree(dest), before, step);
    assert.equal(existsSync(join(dest, "src", "slim", "ms.ts")), false, step);
  }
});

test("qualification leaves no package-manager store or tarball in the Slim checkout", () => {
  assert.equal(existsSync(join(ROOT, ".pnpm-store")), false);
  assert.equal(existsSync(join(ROOT, "node_modules", ".pnpm-store")), false);
  assert.equal(
    readdirSync(ROOT).some((f) => f.endsWith(".tgz")),
    false,
  );
});
