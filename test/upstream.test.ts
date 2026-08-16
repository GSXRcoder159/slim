import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCli } from "../src/cli.ts";
import { EXIT_FAIL, EXIT_OK, SlimExit } from "../src/exit.ts";
import { ENVELOPE_VERSION, emptyHyrum, type Envelope } from "../src/envelope/types.ts";
import type { FuzzReport } from "../src/fuzz/run.ts";
import { sliceExposure } from "../src/upstream/slice.ts";
import { runUpstream, type UpstreamDeps } from "../src/upstream.ts";
import type { OsvVuln } from "../src/upstream/osv.ts";

test("CWE-1321 with get in envelope is exposed", () => {
  const exp = sliceExposure(
    {
      id: "GHSA-x",
      summary: "Prototype pollution",
      details: "via _.set",
      database_specific: { cwe_ids: ["CWE-1321"] },
    },
    ["get", "debounce"],
  );
  assert.equal(exp, "exposed");
});

test("unmapped advisory fail-closed", () => {
  const exp = sliceExposure(
    {
      id: "GHSA-y",
      summary: "Something vague in lodash",
      details: "See advisory.",
    },
    ["get"],
  );
  assert.equal(exp, "unmapped");
});

const CWE_1321: OsvVuln = {
  id: "GHSA-x",
  summary: "Prototype pollution in lodash set",
  details: "Prototype pollution via _.set / _.get (CWE-1321).",
  database_specific: { cwe_ids: ["CWE-1321"] },
};

const UNMAPPED: OsvVuln = {
  id: "GHSA-unmapped",
  summary: "Something vague in lodash",
  details: "See advisory.",
};

function okFuzz(): FuzzReport {
  return {
    cases: 1,
    comparisons: 1,
    timerCases: 0,
    disagreements: [],
    tracesReplayed: 0,
    wallMs: 1,
    seed: 1,
  };
}

function minimalEnvelope(pkg: string, symbols: string[], version: string): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: pkg, version, family: pkg.startsWith("lodash") ? "lodash" : pkg, subpath: "" },
    env: ["node"],
    imports: [
      {
        loc: { file: "src/index.ts", line: 1, column: 0, endLine: 1, endColumn: 10 },
        specifier: pkg,
        kind: "named",
        names: symbols,
      },
    ],
    symbols: symbols.map((exportName) => ({
      exportName,
      packages: [],
      callSites: [],
      resultMembers: [],
      hyrum: emptyHyrum(),
      coverage: { callSitesStatic: 1, callSitesTraced: 0 },
    })),
    unknowns: [],
    traces: [],
    closure: {
      confidence: "closed",
      readyToGenerate: true,
      untracedCallSiteIds: [],
      reason: "test",
    },
    slimmable: { score: 80, verdict: "slim", blockers: [], reasons: [] },
    clock: false,
    cryptoRandom: false,
  };
}

function writeFixture(opts?: { pkg?: string; symbols?: string[]; version?: string }) {
  const pkg = opts?.pkg ?? "lodash";
  const symbols = opts?.symbols ?? ["get", "set"];
  const version = opts?.version ?? "4.17.21";
  const root = mkdtempSync(join(tmpdir(), "slim-up-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "up-mini", type: "module", version: "1.0.0" }),
  );
  mkdirSync(join(root, ".slim", pkg), { recursive: true });
  mkdirSync(join(root, "src", "slim"), { recursive: true });
  const moduleRel = `src/slim/${pkg.replace(/\//g, "-")}.ts`;
  writeFileSync(
    join(root, ".slim", "manifest.json"),
    JSON.stringify(
      {
        replacements: {
          [pkg]: { version, envelopeHash: "h", symbols, module: moduleRel },
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(root, moduleRel), "export function get() {}\nexport function set(o: unknown) { return o; }\n");
  writeFileSync(
    join(root, ".slim", pkg, "envelope.json"),
    JSON.stringify(minimalEnvelope(pkg, symbols, version), null, 2),
  );
  return { root, moduleRel, pkg, symbols };
}

function baseDeps(over: Partial<UpstreamDeps> & { cwd: string }): UpstreamDeps {
  return {
    npmLatest: async () => ({ version: "4.17.21" }),
    queryOsv: async () => [],
    assembleCatalogModule: () =>
      "export function get(o: unknown, _p?: unknown, d?: unknown) { return d; }\nexport function set(o: unknown) { return o; }\n",
    runFuzz: async () => okFuzz(),
    createPullRequest: async () => ({ url: null, local: true }),
    installUpstream: async () => null,
    llmConfigFromEnv: () => null,
    generateWithLlm: async () => ({
      source: "export function get() { return undefined; }\n",
      promptHash: "h",
    }),
    ...over,
  };
}

test("exposed CWE-1321 get/set invokes catalog regenerate", async () => {
  const { root } = writeFixture();
  let assembled = 0;
  const deps = baseDeps({
    cwd: root,
    queryOsv: async () => [CWE_1321],
    assembleCatalogModule: (env) => {
      assembled += 1;
      assert.ok(env.symbols.some((s) => s.exportName === "get" || s.exportName === "set"));
      return "export function get(o: unknown, _p?: unknown, d?: unknown) { return d; }\nexport function set(o: unknown) { return o; }\n";
    },
  });
  await assert.rejects(
    () => runUpstream(parseCli(["upstream"]), deps),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL,
  );
  assert.ok(assembled > 0, "assembleCatalogModule should run for exposed CWE-1321 get/set");
});

test("unmapped advisory is fail-closed and invokes regenerate", async () => {
  const { root } = writeFixture({ symbols: ["get"] });
  let assembled = 0;
  const deps = baseDeps({
    cwd: root,
    queryOsv: async () => [UNMAPPED],
    assembleCatalogModule: () => {
      assembled += 1;
      return "export function get(o: unknown, _p?: unknown, d?: unknown) { return d; }\n";
    },
  });
  await assert.rejects(
    () => runUpstream(parseCli(["upstream"]), deps),
    (err: unknown) =>
      err instanceof SlimExit &&
      err.code === EXIT_FAIL &&
      /exposed|unmapped/i.test(err.message),
  );
  assert.ok(assembled > 0, "unmapped advisory should still regenerate the slice");
});

test("routine release (newer version, zero vulns) is fail-open", async () => {
  const { root } = writeFixture();
  let assembled = 0;
  let prs = 0;
  const deps = baseDeps({
    cwd: root,
    npmLatest: async () => ({ version: "4.17.22" }),
    queryOsv: async () => [],
    assembleCatalogModule: () => {
      assembled += 1;
      return "export function get() {}\n";
    },
    createPullRequest: async () => {
      prs += 1;
      return { url: null, local: true };
    },
  });
  const code = await runUpstream(parseCli(["upstream", "--pr"]), deps);
  assert.equal(code, EXIT_OK);
  assert.equal(assembled, 0, "routine release must not regenerate");
  assert.equal(prs, 0, "routine release must not open a PR");
});

test("--pr title is slim: upstream slice fix for <id>", async () => {
  const { root } = writeFixture();
  let title = "";
  let body = "";
  let branch = "";
  const deps = baseDeps({
    cwd: root,
    queryOsv: async () => [CWE_1321],
    createPullRequest: async (opts) => {
      title = opts.title;
      body = opts.body;
      branch = opts.branch;
      return { url: "https://example.test/pr/1", local: false };
    },
  });
  await assert.rejects(
    () => runUpstream(parseCli(["upstream", "--pr"]), deps),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL,
  );
  assert.equal(title, "slim: upstream slice fix for GHSA-x");
  assert.equal(branch, "slim/upstream");
  assert.match(body, /GHSA-x/);
  assert.match(body, /EVIDENCE, NOT PROOF|evidence/i);
  const review = readFileSync(join(root, ".slim", "UPSTREAM.md"), "utf8");
  assert.match(review, /GHSA-x/);
});

test("catalog disagreement is a Slim bug and does not LLM-patch", async () => {
  const { root } = writeFixture();
  let llm = 0;
  const deps = baseDeps({
    cwd: root,
    queryOsv: async () => [CWE_1321],
    runFuzz: async () => ({
      ...okFuzz(),
      disagreements: [{ symbol: "get", args: ["a"], reason: "return mismatch" }],
    }),
    generateWithLlm: async () => {
      llm += 1;
      return { source: "export function get() { return 1; }\n", promptHash: "h" };
    },
  });
  await assert.rejects(
    () => runUpstream(parseCli(["upstream"]), deps),
    (err: unknown) =>
      err instanceof SlimExit &&
      err.code === EXIT_FAIL &&
      /catalog disagreement/i.test(err.message),
  );
  assert.equal(llm, 0, "must not LLM-patch catalog bodies");
});
