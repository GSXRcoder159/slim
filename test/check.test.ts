import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCli } from "../src/cli.ts";
import { runCheck, runStandingTests, type CheckSpawn } from "../src/check.ts";
import { EXIT_FAIL, EXIT_OK, SlimExit } from "../src/exit.ts";
import { hashEnvelope } from "../src/envelope/types.ts";
import { validateNamed } from "../src/schema/documents.ts";
import { emitHardenedGetSetTest } from "../src/evidence/emit-tests.ts";
import { replacementStateIssues } from "../src/upstream/state.ts";
import { minimalEnvelope, minimalEvidence, minimalManifest, rebindEvidenceArtifacts } from "./helpers/documents.ts";
import type { EvidenceJson } from "../src/evidence/report.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function linkTypescript(root: string) {
  const tsDir = dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
  mkdirSync(join(root, "node_modules"), { recursive: true });
  const dest = join(root, "node_modules", "typescript");
  if (!existsSync(dest)) symlinkSync(tsDir, dest);
}

function writeEnvelope(root: string, pkg: string, exportNames: string[]) {
  const dir = join(root, ".slim", pkg);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "envelope.json"), JSON.stringify(minimalEnvelope(pkg, exportNames)));
}

function completeFiles(extra: Record<string, string> = {}): Record<string, string> {
  const env = minimalEnvelope("lodash", ["get"]);
  return {
    "src/slim/lodash.ts": "export function get() { return 1; }\n",
    "src/slim/lodash.test.ts": `import { test } from "node:test";\ntest("standing", () => {});\n`,
    "src/slim/lodash.hardened.test.ts": `import { test } from "node:test";\ntest("hardened", () => {});\n`,
    ".slim/lodash/evidence.json": JSON.stringify(minimalEvidence(env)),
    ".slim/manifest.json": JSON.stringify(minimalManifest(env)),
    ...extra,
  };
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, stdout: out.join(""), stderr: err.join("") };
  } catch (e) {
    if (e instanceof SlimExit) {
      return { code: e.code, stdout: out.join(""), stderr: err.join("") };
    }
    throw e;
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

function fixture(opts: {
  scripts?: Record<string, string>;
  testCommand?: string | null;
  replacements?: Record<string, { version: string; envelope: string; module: string }>;
  files?: Record<string, string>;
  extraPkg?: Record<string, unknown>;
  freezeEvidence?: boolean;
}): string {
  const root = mkdtempSync(join(tmpdir(), "slim-check-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "check-mini",
      type: "module",
      scripts: opts.scripts ?? {},
      ...opts.extraPkg,
    }),
  );
  const replacements = opts.replacements ?? {
    lodash: {
      version: "4.17.21",
      envelope: ".slim/lodash/envelope.json",
      module: "src/slim/lodash.ts",
    },
  };
  writeFileSync(
    join(root, "slim.json"),
    JSON.stringify({
      outDir: "src/slim",
      testCommand: opts.testCommand ?? null,
      replacements,
    }),
  );
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export const n = 1;\n");
  if (Object.keys(replacements).length) {
    writeEnvelope(root, "lodash", ["get"]);
  }
  for (const [p, body] of Object.entries(opts.files ?? {})) {
    const abs = join(root, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  if (!opts.freezeEvidence && Object.keys(replacements).length) {
    rebindEvidenceArtifacts(root, "lodash", "src/slim");
  }
  linkTypescript(root);
  return root;
}

test("empty replacements exit 0", async () => {
  const root = fixture({ replacements: {} });
  const code = await runCheck(parseCli(["check"]), { cwd: root });
  assert.equal(code, EXIT_OK);
});

test("standing tests run scripts.slim:evidence and fail on nonzero", async () => {
  const root = fixture({
    scripts: { "slim:evidence": "node fail-evidence.js" },
    files: completeFiles({ "fail-evidence.js": "process.exit(1);\n" }),
  });
  await assert.rejects(
    () => runCheck(parseCli(["check"]), { cwd: root }),
    (err: unknown) =>
      err instanceof SlimExit &&
      err.code === EXIT_FAIL &&
      /standing/i.test(err.message),
  );
});

test("standing tests run emitted src/slim/<pkg>.test.ts via node --test when slim:evidence is absent", () => {
  const root = fixture({
    files: {
      "src/slim/lodash.test.ts": `import { test } from "node:test";
test("fail", () => { throw new Error("standing fail"); });
`,
    },
  });
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn: CheckSpawn = (command, args = []) => {
    calls.push({ command, args: [...args] });
    return { status: 1 };
  };
  assert.throws(
    () => runStandingTests(root, "lodash", "src/slim", spawn),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, process.execPath);
  assert.ok(calls[0]!.args.includes("--test"));
  assert.ok(calls[0]!.args.some((a) => a.endsWith("src/slim/lodash.test.ts") || a === "src/slim/lodash.test.ts"));
});

test("slim:evidence is preferred over the emitted test file", () => {
  const root = fixture({
    scripts: { "slim:evidence": "node evidence.js" },
    files: {
      "evidence.js": "process.exit(0);\n",
      "src/slim/lodash.test.ts": "throw new Error('should not run');\n",
    },
  });
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn: CheckSpawn = (command, args = []) => {
    calls.push({ command, args: [...args] });
    return { status: 0 };
  };
  runStandingTests(root, "lodash", "src/slim", spawn);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, process.execPath);
  assert.deepEqual(calls[0]!.args, ["evidence.js"]);
});

test("standing-test spawn prepends node_modules/.bin to PATH", () => {
  const root = fixture({
    scripts: { "slim:evidence": "evidence-runner" },
  });
  let pathEnv = "";
  const spawn: CheckSpawn = (_command, _args, options) => {
    pathEnv = String(options?.env?.PATH ?? "");
    return { status: 0 };
  };
  runStandingTests(root, "lodash", "src/slim", spawn);
  const bin = join(root, "node_modules", ".bin");
  assert.ok(pathEnv.startsWith(bin), `PATH should start with ${bin}, got ${pathEnv}`);
});

test("runCheck runs config.testCommand after standing tests; nonzero is EXIT_FAIL", async () => {
  const root = fixture({
    scripts: { "slim:evidence": "node ok.js" },
    testCommand: "node fail-cmd.js",
    files: completeFiles({
      "ok.js": "process.exit(0);\n",
      "fail-cmd.js": "process.exit(1);\n",
    }),
  });
  await assert.rejects(
    () => runCheck(parseCli(["check"]), { cwd: root }),
    (err: unknown) =>
      err instanceof SlimExit &&
      err.code === EXIT_FAIL &&
      /testCommand|test command|project test/i.test(err.message),
  );
});

test("missing standing tests fail check", async () => {
  const root = fixture({});
  await assert.rejects(
    () => runCheck(parseCli(["check"]), { cwd: root }),
    (err: unknown) =>
      err instanceof SlimExit &&
      err.code === EXIT_FAIL &&
      /slim check failed/.test(err.message),
  );
});

test("failing hardened test fails check", async () => {
  const root = fixture({
    scripts: { "slim:evidence": "node ok.js" },
    files: completeFiles({
      "ok.js": "process.exit(0);\n",
      "src/slim/lodash.ts": "export function get() { return 1; }\n",
      "src/slim/lodash.hardened.test.ts": `import { test } from "node:test";
test("fail", () => { throw new Error("hardened fail"); });
`,
    }),
  });
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn: CheckSpawn = (command, args = []) => {
    calls.push({ command, args: [...args] });
    if (args.some((a) => String(a).includes("hardened"))) return { status: 1 };
    return { status: 0 };
  };
  await assert.rejects(
    () => runCheck(parseCli(["check"]), { cwd: root, spawn }),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL,
  );
  assert.ok(calls.some((c) => c.args.some((a) => String(a).includes("hardened"))));
});

test("malformed envelope fails check", async () => {
  const root = fixture({
    scripts: { "slim:evidence": "node ok.js" },
    files: { "ok.js": "process.exit(0);\n" },
  });
  writeFileSync(join(root, ".slim", "lodash", "envelope.json"), "{");
  await assert.rejects(
    () => runCheck(parseCli(["check"]), { cwd: root }),
    (err: unknown) =>
      err instanceof SlimExit &&
      err.code === EXIT_FAIL &&
      /malformed envelope/.test(err.message),
  );
});

test("slim check [pkg] rejects unknown package", async () => {
  const root = fixture({
    scripts: { "slim:evidence": "node ok.js" },
    files: { "ok.js": "process.exit(0);\n" },
  });
  await assert.rejects(
    () => runCheck(parseCli(["check", "left-pad"]), { cwd: root }),
    (err: unknown) =>
      err instanceof SlimExit &&
      err.code === EXIT_FAIL &&
      /left-pad/.test(err.message),
  );
});

test("hash mismatch vs evidence.json fails check", async () => {
  const root = fixture({
    scripts: { "slim:evidence": "node ok.js" },
    files: {
      "ok.js": "process.exit(0);\n",
      "src/slim/lodash.ts": "export function get() { return 1; }\n",
      ".slim/lodash/evidence.json": JSON.stringify(
        minimalEvidence(minimalEnvelope("lodash", ["get"]), { envelopeHash: "0".repeat(64) }),
      ),
    },
  });
  await assert.rejects(
    () => runCheck(parseCli(["check"]), { cwd: root }),
    (err: unknown) =>
      err instanceof SlimExit &&
      err.code === EXIT_FAIL &&
      /slim check failed/.test(err.message),
  );
});

test("slim-check.yml has no continue-on-error and uses ./action/check", () => {
  const yml = readFileSync(join(REPO_ROOT, ".github/workflows/slim-check.yml"), "utf8");
  assert.equal(/continue-on-error/.test(yml), false);
  assert.match(yml, /uses:\s*\.\/action\/check/);
  assert.match(yml, /npm run build/);
  assert.doesNotMatch(yml, /SLIM_REQUIRE_DIST/);
});

test("slim-bloat.yml runs the bloat action, not scan --json", () => {
  const yml = readFileSync(join(REPO_ROOT, ".github/workflows/slim-bloat.yml"), "utf8");
  assert.equal(/scan\s+--json/.test(yml), false);
  assert.match(yml, /uses:\s*\.\/action\/bloat/);
  assert.match(yml, /npm run build/);
  assert.doesNotMatch(yml, /SLIM_REQUIRE_DIST/);
});

test("slim-upstream.yml keeps weekly cron and runs the compiled action", () => {
  const yml = readFileSync(join(REPO_ROOT, ".github/workflows/slim-upstream.yml"), "utf8");
  assert.match(yml, /cron:\s*"0 8 \* \* 1"/);
  assert.match(yml, /uses:\s*\.\/action\/upstream/);
  assert.match(yml, /contents:\s*write/);
  assert.match(yml, /pull-requests:\s*write/);
  assert.match(yml, /npm run build/);
  assert.doesNotMatch(yml, /SLIM_REQUIRE_DIST/);
  assert.match(yml, /upload-artifact/);
  assert.match(yml, /if:\s*failure\(\)/);
  assert.equal(/node dist\/main\.js upstream --pr/.test(yml), false);
});

test("ci.yml checks golden fixture without inspect overwrite", () => {
  const yml = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(yml, /fixtures\/lodash-get-debounce/);
  assert.match(yml, /dist\/main.js check/);
  assert.equal(
    /inspect\s+lodash/.test(yml),
    false,
    "inspect lodash writes envelope.json and must not run before check",
  );
  const inspectStep = yml.search(/name:\s*fixture inspect/);
  const checkStep = yml.search(/name:\s*fixture check|main\.ts check/);
  assert.ok(checkStep !== -1, "fixture slim check must remain");
  assert.ok(
    inspectStep === -1 || inspectStep > checkStep,
    "inspect must not run before check (it overwrites the golden envelope)",
  );
});

test("release.yml publishes with provenance on v* tags", () => {
  const yml = readFileSync(join(REPO_ROOT, ".github/workflows/release.yml"), "utf8");
  assert.match(yml, /tags:/);
  assert.match(yml, /v\*/);
  assert.match(yml, /id-token:\s*write/);
  assert.match(yml, /contents:\s*write/);
  assert.match(yml, /release-gate/);
  assert.match(yml, /--tarball/);
  assert.match(yml, /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/);
  assert.match(yml, /registry-url:/);
  assert.doesNotMatch(yml, /^\s+- run: npm publish --provenance\s*$/m);
});

test("action.yml files invoke action/run.mjs and require Node 22.18", () => {
  for (const name of ["check", "bloat", "upstream"] as const) {
    const yml = readFileSync(join(REPO_ROOT, `action/${name}/action.yml`), "utf8");
    assert.match(yml, /\.\.\/run\.mjs/);
    assert.doesNotMatch(yml, /experimental-strip-types/);
    assert.match(yml, /using:\s*composite/);
    assert.match(yml, /Node >= 22\.18/);
    assert.match(yml, /node-version: '22\.18'/);
    assert.match(yml, /split\('\.'\)\[1\]/);
    assert.match(yml, /-lt 18/);
  }
});

test("missing evidence fails check even when standing tests pass", async () => {
  const files = completeFiles({ "ok.js": "process.exit(0);\n" });
  delete files[".slim/lodash/evidence.json"];
  const root = fixture({
    scripts: { "slim:evidence": "node ok.js" },
    files,
  });
  const spawn: CheckSpawn = () => ({ status: 0 });
  await assert.rejects(
    () => runCheck(parseCli(["check"]), { cwd: root, spawn }),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL,
  );
});

test("hash-only evidence is rejected", async () => {
  const env = minimalEnvelope("lodash", ["get"]);
  const root = fixture({
    scripts: { "slim:evidence": "node ok.js" },
    files: completeFiles({
      "ok.js": "process.exit(0);\n",
      ".slim/lodash/evidence.json": JSON.stringify({
        schemaVersion: 1,
        envelopeHash: hashEnvelope(env),
      }),
    }),
  });
  const spawn: CheckSpawn = () => ({ status: 0 });
  await assert.rejects(
    () => runCheck(parseCli(["check"]), { cwd: root, spawn }),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL,
  );
});

test("missing manifest fails when replacements are recorded", async () => {
  const files = completeFiles({ "ok.js": "process.exit(0);\n" });
  delete files[".slim/manifest.json"];
  const root = fixture({
    scripts: { "slim:evidence": "node ok.js" },
    files,
  });
  const spawn: CheckSpawn = () => ({ status: 0 });
  await assert.rejects(
    () => runCheck(parseCli(["check"]), { cwd: root, spawn }),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL,
  );
});

test("missing hardening tests fail check", async () => {
  const files = completeFiles({ "ok.js": "process.exit(0);\n" });
  delete files["src/slim/lodash.hardened.test.ts"];
  const root = fixture({
    scripts: { "slim:evidence": "node ok.js" },
    files,
  });
  const spawn: CheckSpawn = () => ({ status: 0 });
  await assert.rejects(
    () => runCheck(parseCli(["check"]), { cwd: root, spawn }),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL,
  );
});

test("standing test that imports the original package fails check", async () => {
  const root = fixture({
    scripts: { "slim:evidence": "node ok.js" },
    files: completeFiles({
      "ok.js": "process.exit(0);\n",
      "src/slim/lodash.test.ts": `import { get } from "lodash";\nimport { test } from "node:test";\ntest("nope", () => { get; });\n`,
    }),
  });
  const spawn: CheckSpawn = () => ({ status: 0 });
  await assert.rejects(
    () => runCheck(parseCli(["check"]), { cwd: root, spawn }),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL,
  );
});

test("human and JSON modes agree on exit for missing evidence", async () => {
  const files = completeFiles({ "ok.js": "process.exit(0);\n" });
  delete files[".slim/lodash/evidence.json"];
  const root = fixture({
    scripts: { "slim:evidence": "node ok.js" },
    files,
  });
  const spawn: CheckSpawn = () => ({ status: 0 });
  const human = await capture(() => runCheck(parseCli(["check"]), { cwd: root, spawn }));
  const machine = await capture(() => runCheck(parseCli(["check", "--json"]), { cwd: root, spawn }));
  assert.equal(human.code, EXIT_FAIL);
  assert.equal(machine.code, human.code);
  const doc = JSON.parse(machine.stdout) as { ok: boolean; exit: number; packages: { drift: { kind: string }[] }[] };
  assert.equal(doc.ok, false);
  assert.equal(doc.exit, EXIT_FAIL);
  assert.ok(doc.packages[0]?.drift.some((d) => d.kind === "evidence"));
});

test("check --json keeps standing-test stdout off the JSON document", async () => {
  const root = fixture({
    files: completeFiles({
      "noisy.js": "console.log('TAP noise { not json'); process.exit(0);\n",
    }),
    scripts: { "slim:evidence": "node noisy.js" },
  });
  const { code, stdout, stderr } = await capture(() =>
    runCheck(parseCli(["check", "--json"]), { cwd: root }),
  );
  assert.equal(code, EXIT_OK, stderr + stdout);
  const doc = JSON.parse(stdout) as { schemaVersion: number; ok: boolean };
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.ok, true);
  assert.equal(validateNamed("check", doc), null);
  assert.match(stderr, /TAP noise/);
  assert.doesNotMatch(stdout, /TAP noise/);
});

test("malformed evidence --json is still one check document", async () => {
  const root = fixture({
    scripts: { "slim:evidence": "node ok.js" },
    files: completeFiles({
      "ok.js": "process.exit(0);\n",
      ".slim/lodash/evidence.json": "{",
    }),
  });
  const spawn: CheckSpawn = () => ({ status: 0 });
  const { code, stdout } = await capture(() => runCheck(parseCli(["check", "--json"]), { cwd: root, spawn }));
  assert.equal(code, EXIT_FAIL);
  const doc = JSON.parse(stdout) as { ok: boolean; packages: { drift: { kind: string }[] }[] };
  assert.equal(doc.ok, false);
  assert.equal(validateNamed("check", doc), null);
  assert.ok(doc.packages[0]?.drift.some((d) => d.kind === "evidence"));
});

test("replacementStateIssues reports missing evidence and hardening", () => {
  const root = fixture({});
  const env = minimalEnvelope("lodash", ["get"]);
  const rec = minimalManifest(env).replacements.lodash;
  const state = replacementStateIssues(root, "lodash", rec, {
    outDir: "src/slim",
    moduleFallback: "src/slim/lodash.ts",
  });
  assert.ok(state.drift.some((d) => d.kind === "evidence"));
  assert.ok(state.drift.some((d) => d.kind === "hardening"));
});

test("emitHardenedGetSetTest writes a sibling hardening file", () => {
  const root = fixture({
    files: { "src/slim/lodash.ts": "export function get() { return 1; }\n" },
  });
  const file = emitHardenedGetSetTest({ root, moduleRel: "src/slim/lodash.ts" });
  assert.ok(existsSync(file));
  assert.match(readFileSync(file, "utf8"), /__proto__/);
  assert.match(readFileSync(file, "utf8"), /node:test/);
});

test("emitHardenedGetSetTest vitest flavor imports vitest", () => {
  const root = fixture({
    files: { "src/slim/ms.ts": "export default function ms() { return 1; }\n" },
  });
  const file = emitHardenedGetSetTest({ root, moduleRel: "src/slim/ms.ts", runner: "vitest" });
  const body = readFileSync(file, "utf8");
  assert.match(body, /from "vitest"/);
  assert.doesNotMatch(body, /node:test/);
});

test("hash-only fixture file fails schema", () => {
  const body = JSON.parse(readFileSync(join(REPO_ROOT, "test/fixtures/evidence/hash-only.json"), "utf8"));
  assert.equal(validateNamed("evidence", body)?.kind, "missing-field");
});

test("forged-complete fixture is schema-valid but unbound to module bytes", () => {
  const body = JSON.parse(
    readFileSync(join(REPO_ROOT, "test/fixtures/evidence/forged-complete.json"), "utf8"),
  ) as EvidenceJson;
  assert.equal(validateNamed("evidence", body), null);
  assert.equal(body.artifacts.moduleDigest, "f".repeat(64));
});

test("changing the module without regenerating evidence fails check", async () => {
  const root = fixture({
    scripts: { "slim:evidence": "node ok.js" },
    files: completeFiles({ "ok.js": "process.exit(0);\n" }),
  });
  writeFileSync(join(root, "src", "slim", "lodash.ts"), "export function get() { return 2; }\n");
  const spawn: CheckSpawn = () => ({ status: 0 });
  const { code, stdout } = await capture(() => runCheck(parseCli(["check", "--json"]), { cwd: root, spawn }));
  assert.equal(code, EXIT_FAIL);
  const doc = JSON.parse(stdout) as { ok: boolean; packages: { drift: { kind: string; detail: string }[] }[] };
  assert.equal(doc.ok, false);
  assert.ok(doc.packages[0]?.drift.some((d) => d.kind === "digest" && /moduleDigest/.test(d.detail)));
});

test("complete-looking forged evidence unbound to module bytes fails check", async () => {
  const env = minimalEnvelope("lodash", ["get"]);
  const forged = JSON.parse(
    readFileSync(join(REPO_ROOT, "test/fixtures/evidence/forged-complete.json"), "utf8"),
  ) as EvidenceJson;
  forged.envelopeHash = hashEnvelope(env);
  const root = fixture({
    freezeEvidence: true,
    scripts: { "slim:evidence": "node ok.js" },
    files: completeFiles({
      "ok.js": "process.exit(0);\n",
      ".slim/lodash/evidence.json": JSON.stringify(forged),
    }),
  });
  const spawn: CheckSpawn = () => ({ status: 0 });
  const human = await capture(() => runCheck(parseCli(["check"]), { cwd: root, spawn }));
  const machine = await capture(() => runCheck(parseCli(["check", "--json"]), { cwd: root, spawn }));
  assert.equal(human.code, EXIT_FAIL);
  assert.equal(machine.code, human.code);
  const doc = JSON.parse(machine.stdout) as { ok: boolean; exit: number; packages: { drift: { kind: string }[] }[] };
  assert.equal(doc.ok, false);
  assert.equal(doc.exit, EXIT_FAIL);
  assert.ok(doc.packages[0]?.drift.some((d) => d.kind === "digest"));
});

test("standing hardening and fixtureRevision digest mismatches fail check", async () => {
  const root = fixture({
    files: completeFiles({}),
  });
  writeFileSync(
    join(root, "src", "slim", "lodash.test.ts"),
    `import { test } from "node:test";\ntest("standing-changed", () => {});\n`,
  );
  const spawn: CheckSpawn = () => ({ status: 0 });
  const { stdout } = await capture(() => runCheck(parseCli(["check", "--json"]), { cwd: root, spawn }));
  const doc = JSON.parse(stdout) as { packages: { drift: { kind: string; detail: string }[] }[] };
  assert.ok(doc.packages[0]?.drift.some((d) => d.kind === "digest" && /standingDigest/.test(d.detail)));
  assert.ok(doc.packages[0]?.drift.some((d) => d.kind === "digest" && /fixtureRevision/.test(d.detail)));

  const rootH = fixture({
    files: completeFiles({}),
  });
  writeFileSync(
    join(rootH, "src", "slim", "lodash.hardened.test.ts"),
    `import { test } from "node:test";\ntest("hardened-changed", () => {});\n`,
  );
  const { stdout: outH } = await capture(() => runCheck(parseCli(["check", "--json"]), { cwd: rootH, spawn }));
  const docH = JSON.parse(outH) as { packages: { drift: { kind: string; detail: string }[] }[] };
  assert.ok(docH.packages[0]?.drift.some((d) => d.kind === "digest" && /hardeningDigest/.test(d.detail)));
});

test("standingDigest hashes the standing test file, not the slim:evidence script", async () => {
  const root = fixture({
    scripts: { "slim:evidence": "node ok.js" },
    files: completeFiles({ "ok.js": "process.exit(0);\n" }),
  });
  writeFileSync(
    join(root, "src", "slim", "lodash.test.ts"),
    `import { test } from "node:test";\ntest("standing-file-changed", () => {});\n`,
  );
  const spawn: CheckSpawn = () => ({ status: 0 });
  const { stdout } = await capture(() => runCheck(parseCli(["check", "--json"]), { cwd: root, spawn }));
  const doc = JSON.parse(stdout) as { packages: { drift: { kind: string; detail: string }[] }[] };
  assert.ok(doc.packages[0]?.drift.some((d) => d.kind === "digest" && /standingDigest/.test(d.detail)));
  assert.ok(doc.packages[0]?.drift.some((d) => d.kind === "digest" && /fixtureRevision/.test(d.detail)));

  const rootScript = fixture({
    scripts: { "slim:evidence": "node ok.js" },
    files: completeFiles({ "ok.js": "process.exit(0);\n" }),
  });
  writeFileSync(
    join(rootScript, "package.json"),
    JSON.stringify({
      name: "check-mini",
      type: "module",
      scripts: { "slim:evidence": "node other.js" },
    }),
  );
  writeFileSync(join(rootScript, "other.js"), "process.exit(0);\n");
  const { stdout: outS } = await capture(() =>
    runCheck(parseCli(["check", "--json"]), { cwd: rootScript, spawn }),
  );
  const docS = JSON.parse(outS) as { packages: { drift: { kind: string; detail: string }[] }[] };
  assert.equal(
    docS.packages[0]?.drift.some((d) => d.kind === "digest" && /standingDigest/.test(d.detail)),
    false,
    "changing slim:evidence must not retarget standingDigest",
  );
});

test("oracleVersion drift fails check", async () => {
  const root = fixture({
    scripts: { "slim:evidence": "node ok.js" },
    files: completeFiles({ "ok.js": "process.exit(0);\n" }),
  });
  const evPath = join(root, ".slim", "lodash", "evidence.json");
  const ev = JSON.parse(readFileSync(evPath, "utf8")) as EvidenceJson;
  ev.artifacts.oracleVersion = "9.9.9";
  writeFileSync(evPath, JSON.stringify(ev));
  const spawn: CheckSpawn = () => ({ status: 0 });
  const { stdout } = await capture(() => runCheck(parseCli(["check", "--json"]), { cwd: root, spawn }));
  const doc = JSON.parse(stdout) as { packages: { drift: { kind: string; detail: string }[] }[] };
  assert.ok(doc.packages[0]?.drift.some((d) => d.kind === "version" && /oracleVersion/.test(d.detail)));
});

test("child timeout and abnormal termination fail check without hanging", async () => {
  const root = fixture({
    scripts: { "slim:evidence": "node ok.js" },
    files: completeFiles({ "ok.js": "process.exit(0);\n" }),
  });
  const timed: CheckSpawn = () => ({
    status: null,
    error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }),
  });
  const { code: tCode, stdout: tOut, stderr: tErr } = await capture(() =>
    runCheck(parseCli(["check", "--json"]), { cwd: root, spawn: timed }),
  );
  assert.equal(tCode, EXIT_FAIL);
  const tDoc = JSON.parse(tOut) as { ok: boolean; packages: { standing: string }[] };
  assert.equal(tDoc.ok, false);
  assert.equal(tDoc.packages[0]?.standing, "fail");
  assert.match(tErr, /timed out/);

  const killed: CheckSpawn = () => ({ status: null, signal: "SIGKILL" });
  const { code: kCode, stdout: kOut, stderr: kErr } = await capture(() =>
    runCheck(parseCli(["check", "--json"]), { cwd: root, spawn: killed }),
  );
  assert.equal(kCode, EXIT_FAIL);
  const kDoc = JSON.parse(kOut) as { ok: boolean };
  assert.equal(kDoc.ok, false);
  assert.match(kErr, /terminated abnormally/);
});
