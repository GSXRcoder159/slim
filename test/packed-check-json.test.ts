import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { hermeticPmEnv, execPm } from "../src/rewrite/lockfile.ts";
import { validateNamed } from "../src/schema/documents.ts";
import { minimalEnvelope, minimalEvidence, minimalManifest } from "./helpers/documents.ts";
import { npmPackTo } from "./helpers/llm-replace.ts";

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

function packSlim(): { tmp: string; packDir: string; slimJs: string } {
  if (!existsSync(join(ROOT, "dist", ".slim-build.json"))) {
    execPm("npm", ["run", "build"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  }
  const packDir = mkdtempSync(join(tmpdir(), "slim-check-pack-"));
  const tarball = npmPackTo(packDir);
  const tmp = mkdtempSync(join(tmpdir(), "slim-check-host-"));
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "host", private: true, type: "module" }));
  execPm("npm", ["install", tarball, "--omit=dev"], {
    cwd: tmp,
    encoding: "utf8",
    timeout: 60_000,
    env: hermeticPmEnv(),
  });
  return { tmp, packDir, slimJs: join(tmp, "node_modules", "slim", "dist", "main.js") };
}

function writeCheckProject(
  proj: string,
  over: {
    evidence?: boolean;
    evidenceBody?: string;
    index?: string;
    standing?: string;
    testCommand?: string | null;
  } = {},
): void {
  mkdirSync(join(proj, "src", "slim"), { recursive: true });
  mkdirSync(join(proj, ".slim", "lodash"), { recursive: true });
  mkdirSync(join(proj, "node_modules"), { recursive: true });
  const env = minimalEnvelope("lodash", ["get"]);
  writeFileSync(
    join(proj, "package.json"),
    JSON.stringify({
      name: "app",
      private: true,
      type: "module",
      scripts: { "slim:evidence": over.standing ?? "node standing.js" },
      dependencies: { lodash: "4.17.21" },
      devDependencies: { typescript: "5.9.2" },
    }),
  );
  writeFileSync(
    join(proj, "slim.json"),
    JSON.stringify({
      outDir: "src/slim",
      testCommand: over.testCommand ?? null,
      replacements: {
        lodash: { version: "4.17.21", envelope: ".slim/lodash/envelope.json", module: "src/slim/lodash.ts" },
      },
    }),
  );
  writeFileSync(join(proj, ".slim", "lodash", "envelope.json"), JSON.stringify(env));
  writeFileSync(join(proj, ".slim", "manifest.json"), JSON.stringify(minimalManifest(env)));
  if (over.evidence !== false) {
    writeFileSync(
      join(proj, ".slim", "lodash", "evidence.json"),
      over.evidenceBody ?? JSON.stringify(minimalEvidence(env)),
    );
  }
  writeFileSync(join(proj, "src", "slim", "lodash.ts"), "export function get() { return 1; }\n");
  writeFileSync(
    join(proj, "src", "slim", "lodash.test.ts"),
    `import { test } from "node:test";\ntest("standing", () => {});\n`,
  );
  writeFileSync(
    join(proj, "src", "slim", "lodash.hardened.test.ts"),
    `import { test } from "node:test";\ntest("hardened", () => {});\n`,
  );
  writeFileSync(join(proj, "src", "index.ts"), over.index ?? "export const n = 1;\n");
  writeFileSync(join(proj, "standing.js"), "console.log('standing-noise'); process.exit(0);\n");
  writeFileSync(join(proj, "fail-standing.js"), "console.log('standing-fail-noise'); process.exit(1);\n");
  writeFileSync(join(proj, "fail-cmd.js"), "console.log('cmd-fail-noise'); process.exit(1);\n");
  const tsDir = dirname(require.resolve("typescript/package.json"));
  const lodashDir = dirname(require.resolve("lodash/package.json"));
  symlinkSync(tsDir, join(proj, "node_modules", "typescript"));
  symlinkSync(lodashDir, join(proj, "node_modules", "lodash"));
}

test("packed check --json is one document for success and every failure class", { timeout: 180_000 }, () => {
  const { tmp, packDir, slimJs } = packSlim();
  try {
    const success = mkdtempSync(join(tmpdir(), "slim-check-ok-"));
    writeCheckProject(success);
    const okJson = run([slimJs, "check", "--json"], success);
    const okHuman = run([slimJs, "check"], success);
    assert.equal(okJson.status, 0, okJson.stderr + okJson.stdout);
    assert.equal(okHuman.status, okJson.status);
    assert.equal(validateNamed("check", JSON.parse(okJson.stdout)), null);
    assert.match(okJson.stderr, /standing-noise/);
    assert.doesNotMatch(okJson.stdout, /standing-noise/);

    const missing = mkdtempSync(join(tmpdir(), "slim-check-noev-"));
    writeCheckProject(missing, { evidence: false });
    const missJson = run([slimJs, "check", "--json"], missing);
    const missHuman = run([slimJs, "check"], missing);
    assert.equal(missJson.status, 1, missJson.stderr + missJson.stdout);
    assert.equal(missHuman.status, missJson.status);
    const missDoc = JSON.parse(missJson.stdout) as { ok: boolean; packages: { drift: { kind: string }[] }[] };
    assert.equal(validateNamed("check", missDoc), null);
    assert.equal(missDoc.ok, false);
    assert.ok(missDoc.packages[0]?.drift.some((d) => d.kind === "evidence"));

    const malformed = mkdtempSync(join(tmpdir(), "slim-check-bad-"));
    writeCheckProject(malformed, { evidenceBody: "{" });
    const badJson = run([slimJs, "check", "--json"], malformed);
    assert.equal(badJson.status, 1, badJson.stderr + badJson.stdout);
    JSON.parse(badJson.stdout);
    assert.ok(validateNamed("check", JSON.parse(badJson.stdout)) === null || validateNamed("error", JSON.parse(badJson.stdout)) === null);

    const drift = mkdtempSync(join(tmpdir(), "slim-check-drift-"));
    writeCheckProject(drift, { index: `import { map } from "lodash";\nexport const x = map([1], (n) => n);\n` });
    const driftJson = run([slimJs, "check", "--json"], drift);
    assert.equal(driftJson.status, 1, driftJson.stderr + driftJson.stdout);
    const driftDoc = JSON.parse(driftJson.stdout) as { ok: boolean; packages: { drift: { kind: string }[] }[] };
    assert.equal(validateNamed("check", driftDoc), null);
    assert.equal(driftDoc.ok, false);
    assert.ok(driftDoc.packages[0]?.drift.some((d) => d.kind === "symbol" || d.kind === "shape" || d.kind === "import"));

    const standingFail = mkdtempSync(join(tmpdir(), "slim-check-st-"));
    writeCheckProject(standingFail, { standing: "node fail-standing.js" });
    const stJson = run([slimJs, "check", "--json"], standingFail);
    const stHuman = run([slimJs, "check"], standingFail);
    assert.equal(stJson.status, 1, stJson.stderr + stJson.stdout);
    assert.equal(stHuman.status, stJson.status);
    assert.equal(validateNamed("check", JSON.parse(stJson.stdout)), null);
    assert.match(stJson.stderr, /standing-fail-noise/);
    assert.doesNotMatch(stJson.stdout, /standing-fail-noise/);

    const cmdFail = mkdtempSync(join(tmpdir(), "slim-check-cmd-"));
    writeCheckProject(cmdFail, { testCommand: "node fail-cmd.js" });
    const cmdJson = run([slimJs, "check", "--json"], cmdFail);
    const cmdHuman = run([slimJs, "check"], cmdFail);
    assert.equal(cmdJson.status, 1, cmdJson.stderr + cmdJson.stdout);
    assert.equal(cmdHuman.status, cmdJson.status);
    assert.equal(validateNamed("check", JSON.parse(cmdJson.stdout)), null);
    assert.match(cmdJson.stderr, /cmd-fail-noise/);
    assert.doesNotMatch(cmdJson.stdout, /cmd-fail-noise/);

    const unknown = run([slimJs, "check", "left-pad", "--json"], success);
    assert.equal(unknown.status, 1, unknown.stderr + unknown.stdout);
    const unknownDoc = JSON.parse(unknown.stdout) as { error?: string; ok: boolean };
    assert.ok(validateNamed("check", unknownDoc) === null || validateNamed("error", unknownDoc) === null);
    assert.equal(unknownDoc.ok, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(packDir, { recursive: true, force: true });
  }
});
