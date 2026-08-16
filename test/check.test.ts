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
  writeFileSync(
    join(dir, "envelope.json"),
    JSON.stringify({
      symbols: exportNames.map((exportName) => ({ exportName })),
    }),
  );
}

function fixture(opts: {
  scripts?: Record<string, string>;
  testCommand?: string | null;
  replacements?: Record<string, { version: string; envelope: string; module: string }>;
  files?: Record<string, string>;
  extraPkg?: Record<string, unknown>;
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
    files: { "fail-evidence.js": "process.exit(1);\n" },
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
  assert.equal(calls[0]!.command, "node");
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
    files: {
      "ok.js": "process.exit(0);\n",
      "fail-cmd.js": "process.exit(1);\n",
    },
  });
  await assert.rejects(
    () => runCheck(parseCli(["check"]), { cwd: root }),
    (err: unknown) =>
      err instanceof SlimExit &&
      err.code === EXIT_FAIL &&
      /testCommand|test command|project test/i.test(err.message),
  );
});

test("slim-check.yml has no continue-on-error and uses ./action/check", () => {
  const yml = readFileSync(join(REPO_ROOT, ".github/workflows/slim-check.yml"), "utf8");
  assert.equal(/continue-on-error/.test(yml), false);
  assert.match(yml, /uses:\s*\.\/action\/check/);
});

test("slim-bloat.yml runs the bloat action, not scan --json", () => {
  const yml = readFileSync(join(REPO_ROOT, ".github/workflows/slim-bloat.yml"), "utf8");
  assert.equal(/scan\s+--json/.test(yml), false);
  assert.match(yml, /uses:\s*\.\/action\/bloat/);
});

test("slim-upstream.yml keeps weekly cron and runs upstream --pr", () => {
  const yml = readFileSync(join(REPO_ROOT, ".github/workflows/slim-upstream.yml"), "utf8");
  assert.match(yml, /cron:\s*"0 8 \* \* 1"/);
  assert.match(yml, /upstream --pr/);
});

test("release.yml publishes with provenance on v* tags", () => {
  const yml = readFileSync(join(REPO_ROOT, ".github/workflows/release.yml"), "utf8");
  assert.match(yml, /tags:/);
  assert.match(yml, /v\*/);
  assert.match(yml, /id-token:\s*write/);
  assert.match(yml, /contents:\s*read/);
  assert.match(yml, /npm publish --provenance/);
  assert.match(yml, /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/);
  assert.match(yml, /registry-url:/);
});

test("action.yml files run strip-types src, not committed dist", () => {
  for (const name of ["check", "bloat", "upstream"] as const) {
    const yml = readFileSync(join(REPO_ROOT, `action/${name}/action.yml`), "utf8");
    assert.equal(
      /dist\/github\//.test(yml),
      false,
      `${name} action.yml still points at dist/`,
    );
    assert.match(yml, /experimental-strip-types/);
    assert.match(yml, /using:\s*composite/);
    assert.match(yml, /Node >= 22\.18/);
    assert.match(yml, /-lt 22/);
  }
});
