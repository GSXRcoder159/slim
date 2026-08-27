import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { hermeticPmEnv } from "../src/rewrite/lockfile.ts";
import { validateNamed } from "../src/schema/documents.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function run(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: hermeticPmEnv({ CI: "1" }),
    timeout: 90_000,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function packAndInstall(): { tmp: string; packDir: string; slimJs: string; proj: string } {
  if (!existsSync(join(ROOT, "dist", ".slim-build.json"))) {
    execFileSync("npm", ["run", "build"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  }
  const packDir = mkdtempSync(join(tmpdir(), "slim-json-pack-"));
  const tgz = execFileSync(
    "npm",
    ["pack", "--silent", "--ignore-scripts", `--pack-destination=${packDir}`],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000, env: hermeticPmEnv() },
  ).trim();
  const tarball = join(packDir, tgz.split("\n").pop() ?? tgz);
  const tmp = mkdtempSync(join(tmpdir(), "slim-json-app-"));
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "host", private: true, type: "module" }));
  execFileSync("npm", ["install", tarball, "--omit=dev"], {
    cwd: tmp,
    encoding: "utf8",
    timeout: 60_000,
    env: hermeticPmEnv(),
  });
  const slimJs = join(tmp, "node_modules", "slim", "dist", "main.js");
  const proj = join(tmp, "app");
  mkdirSync(join(proj, "src"), { recursive: true });
  mkdirSync(join(proj, "node_modules"), { recursive: true });
  writeFileSync(
    join(proj, "package.json"),
    JSON.stringify({
      name: "app",
      private: true,
      type: "module",
      dependencies: { lodash: "4.17.21" },
      devDependencies: { typescript: "5.9.2" },
    }),
  );
  symlinkSync(dirname(require.resolve("lodash/package.json")), join(proj, "node_modules", "lodash"));
  symlinkSync(dirname(require.resolve("typescript/package.json")), join(proj, "node_modules", "typescript"));
  writeFileSync(join(proj, "src", "index.ts"), `import { get } from "lodash";\nexport const x = get({ a: 1 }, "a");\n`);
  return { tmp, packDir, slimJs, proj };
}

test("packed JSON commands emit one schema-valid document; replace --json is usage", { timeout: 180_000 }, () => {
  const { tmp, packDir, slimJs, proj } = packAndInstall();
  try {
    const scan = run([slimJs, "scan", "--json"], proj);
    assert.equal(scan.status, 0, scan.stderr);
    assert.equal(validateNamed("scan", JSON.parse(scan.stdout)), null);

    const doctor = run([slimJs, "doctor", "--json"], proj);
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.equal(validateNamed("doctor", JSON.parse(doctor.stdout)), null);

    const inspect = run([slimJs, "inspect", "lodash", "--json"], proj);
    assert.equal(inspect.status, 0, inspect.stderr + inspect.stdout);
    const inspectDoc = JSON.parse(inspect.stdout) as { schemaVersion: number; envelope: unknown };
    assert.equal(inspectDoc.schemaVersion, 1);
    assert.equal(validateNamed("inspect", inspectDoc), null);
    assert.equal(validateNamed("envelope", inspectDoc.envelope), null);

    const check = run([slimJs, "check", "--json"], proj);
    assert.equal(check.status, 0, check.stderr);
    assert.equal(validateNamed("check", JSON.parse(check.stdout)), null);

    const replace = run([slimJs, "replace", "lodash", "--json"], proj);
    assert.equal(replace.status, 2, replace.stderr + replace.stdout);
    assert.match(replace.stderr, /replace does not support --json/);
    assert.equal(validateNamed("error", JSON.parse(replace.stdout)), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(packDir, { recursive: true, force: true });
  }
});
