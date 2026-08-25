import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCli, runCli, helpText } from "../src/cli.ts";
import { runCheck } from "../src/check.ts";
import { loadConfig } from "../src/config.ts";
import { EXIT_FAIL, EXIT_OK, EXIT_USAGE, SlimExit } from "../src/exit.ts";
import { existsSync, symlinkSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function linkTypescript(root: string) {
  const tsDir = dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
  mkdirSync(join(root, "node_modules"), { recursive: true });
  const dest = join(root, "node_modules", "typescript");
  if (!existsSync(dest)) symlinkSync(tsDir, dest);
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
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

function oneJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  assert.ok(trimmed.startsWith("{"), stdout);
  return JSON.parse(stdout) as Record<string, unknown>;
}

test("unknown command --json emits one error document on stdout", async () => {
  const { code, stdout, stderr } = await capture(() => runCli(["nope", "--json"]));
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /unknown command/);
  const doc = oneJson(stdout);
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.ok, false);
  assert.equal(doc.exit, EXIT_USAGE);
  assert.equal(doc.status, "usage");
  assert.equal(typeof doc.error, "string");
});

test("inspect without pkg --json emits one error document", async () => {
  const { code, stdout } = await capture(() => runCli(["inspect", "--json"]));
  assert.equal(code, EXIT_USAGE);
  const doc = oneJson(stdout);
  assert.equal(doc.ok, false);
  assert.equal(doc.exit, EXIT_USAGE);
  assert.equal(doc.status, "usage");
});

test("check --json with no replacements is one document", async () => {
  const root = mkdtempSync(join(tmpdir(), "slim-json-empty-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "empty", type: "module" }));
  linkTypescript(root);
  const { code, stdout } = await capture(() => runCheck(parseCli(["check", "--json"]), { cwd: root }));
  assert.equal(code, EXIT_OK);
  const doc = oneJson(stdout);
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.ok, true);
  assert.equal(doc.exit, 0);
  assert.equal(doc.status, "ok");
  assert.ok(Array.isArray(doc.packages));
  assert.equal((doc.packages as unknown[]).length, 0);
});

test("check --json failure is still one document", async () => {
  const root = mkdtempSync(join(tmpdir(), "slim-json-fail-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fail",
      type: "module",
      scripts: { "slim:evidence": "node fail-evidence.js" },
    }),
  );
  writeFileSync(
    join(root, "slim.json"),
    JSON.stringify({
      outDir: "src/slim",
      replacements: {
        lodash: { version: "4.17.21", envelope: ".slim/lodash/envelope.json", module: "src/slim/lodash.ts" },
      },
    }),
  );
  mkdirSync(join(root, ".slim", "lodash"), { recursive: true });
  writeFileSync(join(root, ".slim", "lodash", "envelope.json"), JSON.stringify({ symbols: [{ exportName: "get" }] }));
  writeFileSync(join(root, "fail-evidence.js"), "process.exit(1);\n");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export const n = 1;\n");
  linkTypescript(root);
  const { code, stdout } = await capture(async () => {
    try {
      return await runCheck(parseCli(["check", "--json"]), { cwd: root });
    } catch (err) {
      if (err instanceof SlimExit) return err.code;
      throw err;
    }
  });
  assert.equal(code, EXIT_FAIL);
  const doc = oneJson(stdout);
  assert.equal(doc.ok, false);
  assert.equal(doc.exit, EXIT_FAIL);
  assert.equal(doc.status, "fail");
  assert.ok(Array.isArray(doc.packages));
  assert.equal((doc.packages as { standing: string }[])[0]?.standing, "fail");
});

test("malformed slim.json throws SlimExit", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-bad-cfg-"));
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, "slim.json"), "{");
  assert.throws(
    () => loadConfig(root),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL && /malformed slim\.json/.test(err.message),
  );
});

test("help text documents check [pkg] [--json]", () => {
  assert.match(helpText(), /slim check \[pkg\] \[--json\]/);
});

test("docs/help-commands check has --json and not --update-envelope", () => {
  const text = readFileSync(join(ROOT, "docs/help-commands.txt"), "utf8");
  const start = text.indexOf("slim check —");
  const end = text.indexOf("--------", start + 10);
  const section = text.slice(start, end === -1 ? undefined : end);
  assert.match(section, /--json/);
  assert.doesNotMatch(section, /--update-envelope/);
  assert.ok(section.split("\n").length <= 40, `check help is ${section.split("\n").length} lines`);
});

test("upstream --json with no manifest is one document", async () => {
  const root = mkdtempSync(join(tmpdir(), "slim-json-up-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "empty", type: "module" }));
  const { runUpstream } = await import("../src/upstream.ts");
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(parseCli(["upstream", "--json"]), {
      cwd: root,
      npmLatest: async () => ({ version: "1.0.0" }),
      queryOsv: async () => [],
    }),
  );
  assert.equal(code, EXIT_OK);
  assert.equal(stderr.trim(), "");
  const doc = oneJson(stdout);
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.ok, true);
  assert.equal(doc.exit, 0);
  assert.equal(doc.status, "ok");
  assert.ok(Array.isArray(doc.findings));
});

test("upstream --json failure is one document with findings, human on stderr", async () => {
  const root = mkdtempSync(join(tmpdir(), "slim-json-up-fail-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "up", type: "module" }));
  mkdirSync(join(root, ".slim", "lodash"), { recursive: true });
  mkdirSync(join(root, "src", "slim"), { recursive: true });
  writeFileSync(
    join(root, ".slim", "manifest.json"),
    JSON.stringify({
      replacements: {
        lodash: { version: "4.17.21", envelopeHash: "h", symbols: ["get"], module: "src/slim/lodash.ts" },
      },
    }),
  );
  writeFileSync(join(root, "src", "slim", "lodash.ts"), "export function get() {}\n");
  const { runUpstream } = await import("../src/upstream.ts");
  const { code, stdout, stderr } = await capture(async () => {
    try {
      return await runUpstream(parseCli(["upstream", "--json"]), {
        cwd: root,
        npmLatest: async () => ({ version: "4.17.21" }),
        queryOsv: async () => [
          { id: "GHSA-unmapped", summary: "vague", details: "See advisory." },
        ],
        assembleCatalogModule: () => "export function get() {}\n",
        runFuzz: async () => ({
          cases: 1,
          comparisons: 1,
          timerCases: 0,
          disagreements: [],
          tracesReplayed: 0,
          wallMs: 1,
          seed: 1,
          allowFlaky: false,
        }),
        createPullRequest: async () => ({ url: null, local: true }),
        installUpstream: async () => null,
        loadOracle: async () => ({ fns: { get() {} }, kind: "old" as const }),
        llmConfigFromEnv: () => null,
        generateWithLlm: async () => ({ source: "export function get() {}\n", promptHash: "h" }),
      });
    } catch (err) {
      if (err instanceof SlimExit) return err.code;
      throw err;
    }
  });
  assert.equal(code, EXIT_FAIL);
  assert.match(stderr, /unmapped|exposed|fail-closed/);
  const doc = oneJson(stdout);
  assert.equal(doc.ok, false);
  assert.equal(doc.exit, EXIT_FAIL);
  assert.equal(doc.status, "fail");
  assert.ok(Array.isArray(doc.findings));
  assert.equal((doc.findings as { exposure: string }[])[0]?.exposure, "unmapped");
});

test("doctor --json includes ok, exit, and status", async () => {
  const { code, stdout } = await capture(() => runCli(["doctor", "--json"]));
  assert.equal(code, EXIT_OK);
  const doc = oneJson(stdout);
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.ok, true);
  assert.equal(doc.exit, 0);
  assert.equal(doc.status, "ok");
  assert.equal(typeof doc.node, "string");
  assert.ok(Array.isArray(doc.issues));
});
