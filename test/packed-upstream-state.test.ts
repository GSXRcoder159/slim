import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermeticPmEnv, execPm } from "../src/rewrite/lockfile.ts";
import { validateNamed } from "../src/schema/documents.ts";
import { minimalEnvelope, minimalEvidence, minimalManifest, rebindEvidenceArtifacts } from "./helpers/documents.ts";
import { packSlim } from "./helpers/llm-replace.ts";

function run(
  slimJs: string,
  args: string[],
  cwd: string,
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [slimJs, ...args], {
    cwd,
    encoding: "utf8",
    env: hermeticPmEnv({ CI: "1" }),
    timeout: 90_000,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function oneJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  assert.ok(trimmed.startsWith("{"), stdout);
  const doc = JSON.parse(trimmed) as Record<string, unknown>;
  assert.equal(validateNamed("upstream", doc), null, stdout);
  return doc;
}

function plantPackedProject(proj: string): void {
  const pkg = "lodash";
  const env = minimalEnvelope(pkg, ["get", "set"]);
  const moduleRel = "src/slim/lodash.ts";
  mkdirSync(join(proj, "src", "slim"), { recursive: true });
  mkdirSync(join(proj, ".slim", pkg), { recursive: true });
  writeFileSync(
    join(proj, "package.json"),
    JSON.stringify({ name: "packed-up", private: true, type: "module" }),
  );
  writeFileSync(join(proj, moduleRel), "export function get() {}\nexport function set(o: unknown) { return o; }\n");
  writeFileSync(join(proj, "src/slim/lodash.test.ts"), `import { test } from "node:test";\ntest("standing", () => {});\n`);
  writeFileSync(
    join(proj, "src/slim/lodash.hardened.test.ts"),
    `import { test } from "node:test";\ntest("hardened", () => {});\n`,
  );
  writeFileSync(join(proj, ".slim", pkg, "envelope.json"), JSON.stringify(env, null, 2));
  writeFileSync(join(proj, ".slim", pkg, "evidence.json"), JSON.stringify(minimalEvidence(env)));
  writeFileSync(join(proj, ".slim", "manifest.json"), JSON.stringify(minimalManifest(env, moduleRel), null, 2));
  rebindEvidenceArtifacts(proj, pkg, "src/slim");
}

test("packed upstream --json refuses an escaping module before not-exposed", { timeout: 180_000 }, () => {
  const { packDir, tarball } = packSlim();
  const host = mkdtempSync(join(tmpdir(), "slim-up-pack-esc-"));
  const proj = join(host, "app");
  try {
    writeFileSync(join(host, "package.json"), JSON.stringify({ name: "host", private: true }));
    execPm("npm", ["install", tarball, "--omit=dev"], {
      cwd: host,
      encoding: "utf8",
      timeout: 60_000,
      env: hermeticPmEnv(),
    });
    const slimJs = join(host, "node_modules", "slim", "dist", "main.js");
    mkdirSync(proj, { recursive: true });
    plantPackedProject(proj);
    const manPath = join(proj, ".slim", "manifest.json");
    const man = JSON.parse(readFileSync(manPath, "utf8")) as {
      replacements: Record<string, { module: string }>;
    };
    man.replacements.lodash.module = "../secret.ts";
    writeFileSync(manPath, JSON.stringify(man, null, 2));
    const r = run(slimJs, ["upstream", "--json"], proj);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.equal(/slice not exposed/i.test(r.stdout + r.stderr), false);
    const doc = oneJson(r.stdout);
    assert.equal(doc.conclusion, "malformed-state");
    assert.equal(doc.action, "blocked");
    assert.match(String(doc.error ?? ""), /unsafe state path/i);
  } finally {
    rmSync(host, { recursive: true, force: true });
    rmSync(packDir, { recursive: true, force: true });
  }
});

test("packed upstream --json missing configured envelope is missing-state", { timeout: 180_000 }, () => {
  const { packDir, tarball } = packSlim();
  const host = mkdtempSync(join(tmpdir(), "slim-up-pack-cfg-"));
  const proj = join(host, "app");
  try {
    writeFileSync(join(host, "package.json"), JSON.stringify({ name: "host", private: true }));
    execPm("npm", ["install", tarball, "--omit=dev"], {
      cwd: host,
      encoding: "utf8",
      timeout: 60_000,
      env: hermeticPmEnv(),
    });
    const slimJs = join(host, "node_modules", "slim", "dist", "main.js");
    mkdirSync(proj, { recursive: true });
    plantPackedProject(proj);
    writeFileSync(
      join(proj, "slim.json"),
      JSON.stringify({
        outDir: "src/slim",
        replacements: {
          lodash: {
            version: "4.17.21",
            envelope: "state/lodash/envelope.json",
            module: "src/slim/lodash.ts",
          },
        },
      }),
    );
    assert.equal(existsSync(join(proj, ".slim/lodash/envelope.json")), true);
    const r = run(slimJs, ["upstream", "--json"], proj);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.equal(/slice not exposed/i.test(r.stdout + r.stderr), false);
    const doc = oneJson(r.stdout);
    assert.equal(doc.conclusion, "missing-state");
    assert.equal(doc.action, "blocked");
  } finally {
    rmSync(host, { recursive: true, force: true });
    rmSync(packDir, { recursive: true, force: true });
  }
});
