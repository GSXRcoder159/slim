import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCli } from "../src/cli.ts";
import { EXIT_ENV, EXIT_FAIL, EXIT_OK, SlimExit } from "../src/exit.ts";
import { ENVELOPE_VERSION, emptyHyrum, hashEnvelope, type Envelope } from "../src/envelope/types.ts";
import type { FuzzReport } from "../src/fuzz/run.ts";
import { sliceExposure } from "../src/upstream/slice.ts";
import { runUpstream, type UpstreamDeps } from "../src/upstream.ts";
import type { OsvVuln } from "../src/upstream/osv.ts";
import { sourceErr, sourceOk } from "../src/upstream/status.ts";
import { minimalEvidence, minimalManifest, rebindEvidenceArtifacts } from "./helpers/documents.ts";

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
  assert.equal(exp.exposure, "exposed");
  assert.match(exp.mappedEvidence, /get|pollution|CWE-1321/i);
  assert.equal(exp.unmappedReason, null);
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
  assert.equal(exp.exposure, "unmapped");
  assert.ok(exp.unmappedReason);
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
    allowFlaky: false,
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
      staticCallSiteIds: [],
      tracedCallSiteIds: [],
      untracedCallSiteIds: [],
      reason: "test",
    },
    slimmable: { score: 80, verdict: "slim", blockers: [], reasons: [] },
    clock: false,
    cryptoRandom: false,
  };
}

function writeFixture(opts?: { pkg?: string; symbols?: string[]; version?: string; slimJson?: boolean }) {
  const pkg = opts?.pkg ?? "lodash";
  const symbols = opts?.symbols ?? ["get", "set"];
  const version = opts?.version ?? "4.17.21";
  const env = minimalEnvelope(pkg, symbols, version);
  const root = mkdtempSync(join(tmpdir(), "slim-up-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "up-mini", type: "module", version: "1.0.0" }),
  );
  mkdirSync(join(root, ".slim", pkg), { recursive: true });
  mkdirSync(join(root, "src", "slim"), { recursive: true });
  const moduleRel = `src/slim/${pkg.replace(/\//g, "-")}.ts`;
  writeFileSync(join(root, ".slim", "manifest.json"), JSON.stringify(minimalManifest(env, moduleRel), null, 2));
  writeFileSync(join(root, moduleRel), "export function get() {}\nexport function set(o: unknown) { return o; }\n");
  writeFileSync(join(root, ".slim", pkg, "envelope.json"), JSON.stringify(env, null, 2));
  writeFileSync(join(root, ".slim", pkg, "evidence.json"), JSON.stringify(minimalEvidence(env)));
  writeFileSync(
    join(root, "src", "slim", `${pkg.replace(/\//g, "-")}.test.ts`),
    `import { test } from "node:test";\ntest("standing", () => {});\n`,
  );
  writeFileSync(
    join(root, "src", "slim", `${pkg.replace(/\//g, "-")}.hardened.test.ts`),
    `import { test } from "node:test";\ntest("hardened", () => {});\n`,
  );
  if (opts?.slimJson) {
    writeFileSync(
      join(root, "slim.json"),
      JSON.stringify({
        outDir: "src/slim",
        replacements: {
          [pkg]: { version, envelope: `.slim/${pkg}/envelope.json`, module: moduleRel },
        },
      }),
    );
  }
  rebindEvidenceArtifacts(root, pkg, "src/slim");
  return { root, moduleRel, pkg, symbols };
}

function baseDeps(over: Partial<UpstreamDeps> & { cwd: string }): UpstreamDeps {
  return {
    npmLatest: async () => sourceOk({ version: "4.17.21" }),
    queryOsv: async () => sourceOk([]),
    githubStatus: () => sourceOk(true),
    assembleCatalogModule: () =>
      "export function get(o: unknown, _p?: unknown, d?: unknown) { return d; }\nexport function set(o: unknown) { return o; }\n",
    runFuzz: async () => okFuzz(),
    createPullRequest: async () => ({ url: null, local: true }),
    installUpstream: async () => null,
    loadOracle: async () => ({
      fns: {
        get() {},
        set(o: unknown) {
          return o;
        },
      },
      kind: "old" as const,
    }),
    llmConfigFromEnv: () => null,
    generateWithLlm: async () => ({
      source: "export function get() { return undefined; }\n",
      promptHash: "h",
    }),
    runStandingTests: () => {},
    runHardenedTests: () => {},
    ...over,
  };
}

test("exposed CWE-1321 get/set invokes catalog regenerate", async () => {
  const { root } = writeFixture();
  let assembled = 0;
  const deps = baseDeps({
    cwd: root,
    queryOsv: async () => sourceOk([CWE_1321]),
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

test("unmapped advisory is fail-closed and does not regenerate", async () => {
  const { root, moduleRel } = writeFixture({ symbols: ["get"] });
  const before = readFileSync(join(root, moduleRel), "utf8");
  let assembled = 0;
  const deps = baseDeps({
    cwd: root,
    queryOsv: async () => sourceOk([UNMAPPED]),
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
      /unmapped/i.test(err.message),
  );
  assert.equal(assembled, 0, "unmapped advisory must not regenerate");
  assert.equal(readFileSync(join(root, moduleRel), "utf8"), before);
  assert.ok(existsSync(join(root, ".slim", "UPSTREAM.md")));
  const review = readFileSync(join(root, ".slim", "UPSTREAM.md"), "utf8");
  assert.match(review, /did not write an automatic fix/i);
});

test("routine release (newer version, zero vulns) is fail-open", async () => {
  const { root } = writeFixture();
  let assembled = 0;
  let prs = 0;
  const deps = baseDeps({
    cwd: root,
    npmLatest: async () => sourceOk({ version: "4.17.22" }),
    queryOsv: async () => sourceOk([]),
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
    queryOsv: async () => sourceOk([CWE_1321]),
    createPullRequest: async (opts) => {
      title = opts.title;
      body = opts.body;
      branch = opts.branch;
      assert.ok(opts.files.includes(".slim/UPSTREAM.md"));
      assert.deepEqual(opts.labels, ["slim", "slim:upstream"]);
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
    queryOsv: async () => sourceOk([CWE_1321]),
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

const PROTO_DISAGREE = {
  symbol: "set",
  args: [{}, "__proto__.polluted", true],
  reason: "return mismatch",
};

test("PR body includes fuzz evidence stats from this run", async () => {
  const { root } = writeFixture();
  let body = "";
  const deps = baseDeps({
    cwd: root,
    queryOsv: async () => sourceOk([CWE_1321]),
    runFuzz: async () => ({
      cases: 42,
      comparisons: 99,
      timerCases: 7,
      disagreements: [],
      tracesReplayed: 3,
      wallMs: 12,
      seed: 1,
    }),
    createPullRequest: async (opts) => {
      body = opts.body;
      return { url: null, local: true };
    },
  });
  await assert.rejects(
    () => runUpstream(parseCli(["upstream", "--pr"]), deps),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL,
  );
  const evidence = readFileSync(join(root, ".slim", "lodash", "evidence.md"), "utf8");
  assert.match(evidence, /cases:\s*42/);
  assert.match(evidence, /comparisons:\s*99/);
  assert.match(evidence, /timerCases:\s*7/);
  assert.match(body, /cases:\s*42/);
  assert.match(body, /comparisons:\s*99/);
  assert.match(body, /timerCases:\s*7/);
  assert.match(body, /regenerated the replacement and fuzzed/i);
});

test("no installable oracle leaves the tree unchanged", async () => {
  const { root, moduleRel } = writeFixture();
  const before = readFileSync(join(root, moduleRel), "utf8");
  let prs = 0;
  const deps = baseDeps({
    cwd: root,
    queryOsv: async () => sourceOk([CWE_1321]),
    loadOracle: async () => null,
    installUpstream: async () => null,
    createPullRequest: async () => {
      prs += 1;
      return { url: null, local: true };
    },
  });
  await assert.rejects(
    () => runUpstream(parseCli(["upstream", "--pr"]), deps),
    (err: unknown) =>
      err instanceof SlimExit &&
      err.code === EXIT_FAIL &&
      /verification unavailable/i.test(err.message),
  );
  assert.equal(readFileSync(join(root, moduleRel), "utf8"), before);
  assert.equal(existsSync(join(root, ".slim", "lodash", "evidence.md")), false);
  assert.equal(existsSync(join(root, ".slim", "UPSTREAM.md")), false);
  assert.equal(prs, 0);
});

test("missing oracle for one exposed package blocks every rewrite", async () => {
  const { root, moduleRel } = writeFixture();
  const before = readFileSync(join(root, moduleRel), "utf8");
  const env2 = minimalEnvelope("underscore", ["get", "set"], "1.13.1");
  const hash2 = hashEnvelope(env2);
  mkdirSync(join(root, ".slim", "underscore"), { recursive: true });
  writeFileSync(join(root, "src/slim/underscore.ts"), "export function get() {}\nexport function set(o: unknown) { return o; }\n");
  writeFileSync(
    join(root, "src/slim/underscore.test.ts"),
    `import { test } from "node:test";\ntest("standing", () => {});\n`,
  );
  writeFileSync(
    join(root, "src/slim/underscore.hardened.test.ts"),
    `import { test } from "node:test";\ntest("hardened", () => {});\n`,
  );
  writeFileSync(join(root, ".slim/underscore/envelope.json"), JSON.stringify(env2, null, 2));
  writeFileSync(join(root, ".slim/underscore/evidence.json"), JSON.stringify(minimalEvidence(env2)));
  const man = JSON.parse(readFileSync(join(root, ".slim/manifest.json"), "utf8")) as {
    replacements: Record<string, { version: string; envelopeHash: string; symbols: string[]; module: string }>;
  };
  man.replacements.underscore = {
    version: "1.13.1",
    envelopeHash: hash2,
    symbols: ["get", "set"],
    module: "src/slim/underscore.ts",
  };
  writeFileSync(join(root, ".slim/manifest.json"), JSON.stringify(man, null, 2));
  rebindEvidenceArtifacts(root, "underscore", "src/slim");
  const before2 = readFileSync(join(root, "src/slim/underscore.ts"), "utf8");
  let assembled = 0;
  const deps = baseDeps({
    cwd: root,
    queryOsv: async () => sourceOk([CWE_1321]),
    loadOracle: async (pkg) =>
      pkg === "lodash"
        ? { fns: { get() {}, set(o: unknown) { return o; } }, kind: "new" as const }
        : null,
    assembleCatalogModule: () => {
      assembled += 1;
      return "export function get() { return; }\nexport function set(o: unknown) { return o; }\n";
    },
  });
  await assert.rejects(
    () => runUpstream(parseCli(["upstream"]), deps),
    (err: unknown) =>
      err instanceof SlimExit &&
      err.code === EXIT_FAIL &&
      /verification unavailable/i.test(err.message),
  );
  assert.equal(assembled, 0, "must not regenerate any package when one oracle is missing");
  assert.equal(readFileSync(join(root, moduleRel), "utf8"), before);
  assert.equal(readFileSync(join(root, "src/slim/underscore.ts"), "utf8"), before2);
});

test("proto disagreement vs new/patched oracle is a Slim bug", async () => {
  const { root } = writeFixture();
  const deps = baseDeps({
    cwd: root,
    queryOsv: async () => sourceOk([CWE_1321]),
    loadOracle: async () => ({
      fns: { get() {}, set(o: unknown) { return o; } },
      kind: "new",
    }),
    runFuzz: async () => ({ ...okFuzz(), disagreements: [PROTO_DISAGREE] }),
  });
  await assert.rejects(
    () => runUpstream(parseCli(["upstream"]), deps),
    (err: unknown) =>
      err instanceof SlimExit &&
      err.code === EXIT_FAIL &&
      /catalog disagreement/i.test(err.message),
  );
});

test("proto disagreement vs old/pinned oracle is dropped", async () => {
  const { root } = writeFixture();
  const deps = baseDeps({
    cwd: root,
    queryOsv: async () => sourceOk([CWE_1321]),
    loadOracle: async () => ({
      fns: { get() {}, set(o: unknown) { return o; } },
      kind: "old",
    }),
    runFuzz: async () => ({ ...okFuzz(), disagreements: [PROTO_DISAGREE] }),
  });
  await assert.rejects(
    () => runUpstream(parseCli(["upstream"]), deps),
    (err: unknown) =>
      err instanceof SlimExit &&
      err.code === EXIT_FAIL &&
      /exposed|unmapped/i.test(err.message) &&
      !/catalog disagreement/i.test(err.message),
  );
});

test("successful regen+fuzz bumps manifest and slim.json pin to latest", async () => {
  const { root } = writeFixture({ slimJson: true });
  let standing = 0;
  let hardened = 0;
  const deps = baseDeps({
    cwd: root,
    npmLatest: async () => sourceOk({ version: "4.17.22" }),
    queryOsv: async (_name, version) => sourceOk(version === "4.17.21" ? [CWE_1321] : []),
    loadOracle: async () => ({
      fns: { get() {}, set(o: unknown) { return o; } },
      kind: "new",
    }),
    runStandingTests: () => {
      standing += 1;
    },
    runHardenedTests: () => {
      hardened += 1;
    },
  });
  await assert.rejects(
    () => runUpstream(parseCli(["upstream"]), deps),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL,
  );
  const man = JSON.parse(readFileSync(join(root, ".slim", "manifest.json"), "utf8")) as {
    replacements: Record<string, { version: string }>;
  };
  assert.equal(man.replacements.lodash?.version, "4.17.22");
  const slim = JSON.parse(readFileSync(join(root, "slim.json"), "utf8")) as {
    replacements: Record<string, { version: string }>;
  };
  assert.equal(slim.replacements.lodash?.version, "4.17.22");
  assert.ok(standing > 0, "standing tests must run after emit");
  assert.ok(hardened > 0, "hardened tests must run after emit");
  assert.ok(existsSync(join(root, "src/slim/lodash.hardened.test.ts")));
});

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
      return { code: e.code, stdout: out.join(""), stderr: err.join("") + e.message };
    }
    throw e;
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

type SourceDoc = {
  ok: boolean;
  exit: number;
  conclusion: string;
  action: string;
  sources: { osv: { status: string; detail: string }; npm: { status: string; detail: string } };
  findings: unknown[];
};

function parseUpstream(stdout: string): SourceDoc {
  const trimmed = stdout.trim();
  assert.ok(trimmed.startsWith("{"), stdout);
  return JSON.parse(trimmed) as SourceDoc;
}

function assertBlockedSource(
  result: { code: number; stdout: string; stderr: string },
  source: "osv" | "npm",
  status: string,
): SourceDoc {
  assert.equal(result.code, EXIT_ENV);
  assert.equal(/slice not exposed/i.test(result.stdout + result.stderr), false);
  const doc = parseUpstream(result.stdout);
  assert.equal(doc.ok, false);
  assert.equal(doc.exit, EXIT_ENV);
  assert.equal(doc.conclusion, "source-unavailable");
  assert.equal(doc.action, "blocked");
  assert.equal(doc.sources[source].status, status);
  return doc;
}

test("OSV outage never prints slice not exposed", async () => {
  const { root } = writeFixture();
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(
      parseCli(["upstream", "--json"]),
      baseDeps({
        cwd: root,
        queryOsv: async () => sourceErr("unavailable", "HTTP 503"),
      }),
    ),
  );
  assertBlockedSource({ code, stdout, stderr }, "osv", "unavailable");
});

test("npm outage with empty OSV never prints slice not exposed", async () => {
  const { root } = writeFixture();
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(
      parseCli(["upstream", "--json"]),
      baseDeps({
        cwd: root,
        npmLatest: async () => sourceErr("unavailable", "HTTP 503"),
        queryOsv: async () => sourceOk([]),
      }),
    ),
  );
  assertBlockedSource({ code, stdout, stderr }, "npm", "unavailable");
});

test("OSV timeout is source-unavailable with status timeout", async () => {
  const { root } = writeFixture();
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(
      parseCli(["upstream", "--json"]),
      baseDeps({
        cwd: root,
        queryOsv: async () => sourceErr("timeout", "timeout: aborted"),
      }),
    ),
  );
  assertBlockedSource({ code, stdout, stderr }, "osv", "timeout");
});

test("npm timeout is source-unavailable with status timeout", async () => {
  const { root } = writeFixture();
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(
      parseCli(["upstream", "--json"]),
      baseDeps({
        cwd: root,
        npmLatest: async () => sourceErr("timeout", "timeout: aborted"),
        queryOsv: async () => sourceOk([]),
      }),
    ),
  );
  assertBlockedSource({ code, stdout, stderr }, "npm", "timeout");
});

test("OSV invalid JSON is source-unavailable with status malformed", async () => {
  const { root } = writeFixture();
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(
      parseCli(["upstream", "--json"]),
      baseDeps({
        cwd: root,
        queryOsv: async () => sourceErr("malformed", "osv.dev response is not JSON"),
      }),
    ),
  );
  assertBlockedSource({ code, stdout, stderr }, "osv", "malformed");
});

test("OSV malformed fields are source-unavailable with status malformed", async () => {
  const { root } = writeFixture();
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(
      parseCli(["upstream", "--json"]),
      baseDeps({
        cwd: root,
        queryOsv: async () => sourceErr("malformed", "osv.dev vuln missing id"),
      }),
    ),
  );
  assertBlockedSource({ code, stdout, stderr }, "osv", "malformed");
});

test("npm malformed fields are source-unavailable with status malformed", async () => {
  const { root } = writeFixture();
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(
      parseCli(["upstream", "--json"]),
      baseDeps({
        cwd: root,
        npmLatest: async () => sourceErr("malformed", "npm registry response missing version"),
        queryOsv: async () => sourceOk([]),
      }),
    ),
  );
  assertBlockedSource({ code, stdout, stderr }, "npm", "malformed");
});

test("all sources down is EXIT_ENV", async () => {
  const { root } = writeFixture();
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(
      parseCli(["upstream", "--json"]),
      baseDeps({
        cwd: root,
        npmLatest: async () => sourceErr("timeout", "timeout: aborted"),
        queryOsv: async () => sourceErr("malformed", "osv.dev response is not JSON"),
      }),
    ),
  );
  const doc = assertBlockedSource({ code, stdout, stderr }, "npm", "timeout");
  assert.equal(doc.sources.osv.status, "malformed");
});

test("npm latest older than pin is stale and never slice not exposed", async () => {
  const { root } = writeFixture();
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(
      parseCli(["upstream", "--json"]),
      baseDeps({
        cwd: root,
        npmLatest: async () => sourceOk({ version: "4.17.0" }),
        queryOsv: async () => sourceOk([]),
      }),
    ),
  );
  assertBlockedSource({ code, stdout, stderr }, "npm", "stale");
});

test("pinned version absent from npm versions is stale", async () => {
  const { root } = writeFixture();
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(
      parseCli(["upstream", "--json"]),
      baseDeps({
        cwd: root,
        npmLatest: async () => sourceOk({ version: "4.17.22", versions: ["4.17.20", "4.17.22"] }),
        queryOsv: async () => sourceOk([]),
      }),
    ),
  );
  assertBlockedSource({ code, stdout, stderr }, "npm", "stale");
});

test("successful empty advisory set may print slice not exposed", async () => {
  const { root } = writeFixture();
  const { code, stdout } = await capture(() =>
    runUpstream(parseCli(["upstream"]), baseDeps({ cwd: root })),
  );
  assert.equal(code, EXIT_OK);
  assert.match(stdout, /slice not exposed/);
});

test("missing envelope blocks automatic action", async () => {
  const { root } = writeFixture();
  rmSync(join(root, ".slim", "lodash", "envelope.json"));
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(parseCli(["upstream"]), baseDeps({ cwd: root })),
  );
  assert.equal(code, EXIT_FAIL);
  assert.equal(/slice not exposed/i.test(stdout + stderr), false);
  assert.match(stderr, /missing envelope/i);
});

test("hash mismatch blocks automatic action", async () => {
  const { root } = writeFixture();
  const env = JSON.parse(readFileSync(join(root, ".slim", "lodash", "envelope.json"), "utf8")) as Envelope;
  writeFileSync(
    join(root, ".slim", "lodash", "evidence.json"),
    JSON.stringify(minimalEvidence(env, { envelopeHash: "0".repeat(64) })),
  );
  await assert.rejects(
    () => runUpstream(parseCli(["upstream"]), baseDeps({ cwd: root })),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL && /envelopeHash/i.test(err.message),
  );
});

test("missing standing tests block automatic action", async () => {
  const { root } = writeFixture();
  rmSync(join(root, "src", "slim", "lodash.test.ts"));
  await assert.rejects(
    () => runUpstream(parseCli(["upstream"]), baseDeps({ cwd: root })),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL && /standing/i.test(err.message),
  );
});

test("schema-incompatible envelope blocks automatic action", async () => {
  const { root } = writeFixture();
  const env = JSON.parse(readFileSync(join(root, ".slim", "lodash", "envelope.json"), "utf8")) as { schemaVersion: number };
  env.schemaVersion = 0;
  writeFileSync(join(root, ".slim", "lodash", "envelope.json"), JSON.stringify(env));
  await assert.rejects(
    () => runUpstream(parseCli(["upstream"]), baseDeps({ cwd: root })),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL && /stale-version|schema-incompatible|schemaVersion/.test(err.message),
  );
});

test("missing manifest is incomplete-state and never not-exposed", async () => {
  const root = mkdtempSync(join(tmpdir(), "slim-up-noman-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "noman", type: "module" }));
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(parseCli(["upstream"]), baseDeps({ cwd: root })),
  );
  assert.equal(code, EXIT_FAIL);
  assert.equal(/slice not exposed/i.test(stdout + stderr), false);
  assert.match(stdout + stderr, /manifest/i);
});

test("empty valid replacements reports no replacements", async () => {
  const root = mkdtempSync(join(tmpdir(), "slim-up-empty-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "empty", type: "module" }));
  mkdirSync(join(root, ".slim"), { recursive: true });
  writeFileSync(join(root, ".slim", "manifest.json"), JSON.stringify({ schemaVersion: 1, replacements: {} }));
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(parseCli(["upstream"]), baseDeps({ cwd: root })),
  );
  assert.equal(code, EXIT_OK);
  assert.match(stdout, /no replacements/);
  assert.equal(/slice not exposed/i.test(stdout + stderr), false);
});

test("hash-only evidence blocks upstream even with a matching envelope hash", async () => {
  const { root } = writeFixture();
  const env = JSON.parse(readFileSync(join(root, ".slim", "lodash", "envelope.json"), "utf8")) as Envelope;
  writeFileSync(
    join(root, ".slim", "lodash", "evidence.json"),
    JSON.stringify({ schemaVersion: 1, envelopeHash: hashEnvelope(env) }),
  );
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(parseCli(["upstream"]), baseDeps({ cwd: root })),
  );
  assert.equal(code, EXIT_FAIL);
  assert.equal(/slice not exposed/i.test(stdout + stderr), false);
  assert.match(stdout + stderr, /evidence/i);
});

test("missing evidence.json blocks upstream", async () => {
  const { root } = writeFixture();
  rmSync(join(root, ".slim", "lodash", "evidence.json"));
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(parseCli(["upstream"]), baseDeps({ cwd: root })),
  );
  assert.equal(code, EXIT_FAIL);
  assert.equal(/slice not exposed/i.test(stdout + stderr), false);
  assert.match(stdout + stderr, /evidence/i);
});

test("missing hardening tests block upstream", async () => {
  const { root } = writeFixture();
  rmSync(join(root, "src", "slim", "lodash.hardened.test.ts"));
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(parseCli(["upstream"]), baseDeps({ cwd: root })),
  );
  assert.equal(code, EXIT_FAIL);
  assert.equal(/slice not exposed/i.test(stdout + stderr), false);
  assert.match(stdout + stderr, /hardening/i);
});

test("manifest version mismatch vs envelope blocks upstream", async () => {
  const { root } = writeFixture();
  const man = JSON.parse(readFileSync(join(root, ".slim", "manifest.json"), "utf8")) as {
    replacements: Record<string, { version: string }>;
  };
  man.replacements.lodash!.version = "9.9.9";
  writeFileSync(join(root, ".slim", "manifest.json"), JSON.stringify(man));
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(parseCli(["upstream"]), baseDeps({ cwd: root })),
  );
  assert.equal(code, EXIT_FAIL);
  assert.match(stdout + stderr, /version/i);
});

test("manifest symbols mismatch vs envelope blocks upstream", async () => {
  const { root } = writeFixture();
  const man = JSON.parse(readFileSync(join(root, ".slim", "manifest.json"), "utf8")) as {
    replacements: Record<string, { symbols: string[] }>;
  };
  man.replacements.lodash!.symbols = ["debounce"];
  writeFileSync(join(root, ".slim", "manifest.json"), JSON.stringify(man));
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(parseCli(["upstream"]), baseDeps({ cwd: root })),
  );
  assert.equal(code, EXIT_FAIL);
  assert.match(stdout + stderr, /symbol/i);
});

test("slim.json pin mismatch blocks upstream", async () => {
  const { root } = writeFixture({ slimJson: true });
  const slim = JSON.parse(readFileSync(join(root, "slim.json"), "utf8")) as {
    replacements: Record<string, { version: string; envelope: string; module: string }>;
  };
  slim.replacements.lodash!.version = "0.0.1";
  writeFileSync(join(root, "slim.json"), JSON.stringify(slim));
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(parseCli(["upstream"]), baseDeps({ cwd: root })),
  );
  assert.equal(code, EXIT_FAIL);
  assert.match(stdout + stderr, /slim\.json|version/i);
});

test("catalog evidence with empty catalogIds blocks upstream", async () => {
  const { root } = writeFixture();
  const env = JSON.parse(readFileSync(join(root, ".slim", "lodash", "envelope.json"), "utf8")) as Envelope;
  writeFileSync(
    join(root, ".slim", "lodash", "evidence.json"),
    JSON.stringify(minimalEvidence(env, { generation: { kind: "catalog", catalogIds: [], attempts: 1, specSource: "catalog", counterexamples: [] } })),
  );
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(parseCli(["upstream"]), baseDeps({ cwd: root })),
  );
  assert.equal(code, EXIT_FAIL);
  assert.match(stdout + stderr, /catalogIds/i);
});

test("second-package regen failure rolls back the first package", async () => {
  const { root, moduleRel } = writeFixture();
  const before = readFileSync(join(root, moduleRel), "utf8");
  const env2 = minimalEnvelope("underscore", ["get", "set"], "1.13.1");
  mkdirSync(join(root, ".slim", "underscore"), { recursive: true });
  writeFileSync(join(root, "src/slim/underscore.ts"), "export function get() {}\nexport function set(o: unknown) { return o; }\n");
  writeFileSync(
    join(root, "src/slim/underscore.test.ts"),
    `import { test } from "node:test";\ntest("standing", () => {});\n`,
  );
  writeFileSync(
    join(root, "src/slim/underscore.hardened.test.ts"),
    `import { test } from "node:test";\ntest("hardened", () => {});\n`,
  );
  writeFileSync(join(root, ".slim/underscore/envelope.json"), JSON.stringify(env2, null, 2));
  writeFileSync(join(root, ".slim/underscore/evidence.json"), JSON.stringify(minimalEvidence(env2)));
  const man = JSON.parse(readFileSync(join(root, ".slim/manifest.json"), "utf8")) as {
    replacements: Record<string, { version: string; envelopeHash: string; symbols: string[]; module: string }>;
  };
  man.replacements.underscore = {
    version: "1.13.1",
    envelopeHash: hashEnvelope(env2),
    symbols: ["get", "set"],
    module: "src/slim/underscore.ts",
  };
  writeFileSync(join(root, ".slim/manifest.json"), JSON.stringify(man, null, 2));
  rebindEvidenceArtifacts(root, "underscore", "src/slim");
  const before2 = readFileSync(join(root, "src/slim/underscore.ts"), "utf8");
  const beforeMan = readFileSync(join(root, ".slim/manifest.json"), "utf8");
  const deps = baseDeps({
    cwd: root,
    queryOsv: async () => sourceOk([CWE_1321]),
    assembleCatalogModule: (_env, _root) => {
      const name = _env.package.name;
      if (name === "underscore") {
        throw new SlimExit(EXIT_FAIL, "injected generate failure for underscore");
      }
      return "export function get(o: unknown, _p?: unknown, d?: unknown) { return d; }\nexport function set(o: unknown) { return o; }\n";
    },
  });
  await assert.rejects(
    () => runUpstream(parseCli(["upstream"]), deps),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL && /underscore/i.test(err.message),
  );
  assert.equal(readFileSync(join(root, moduleRel), "utf8"), before);
  assert.equal(readFileSync(join(root, "src/slim/underscore.ts"), "utf8"), before2);
  assert.equal(readFileSync(join(root, ".slim/manifest.json"), "utf8"), beforeMan);
});

test("regen writes originalMin and matching hashes", async () => {
  const { root } = writeFixture({ slimJson: true });
  const deps = baseDeps({
    cwd: root,
    npmLatest: async () => sourceOk({ version: "4.17.22" }),
    queryOsv: async (_name, version) => sourceOk(version === "4.17.21" ? [CWE_1321] : []),
    loadOracle: async () => ({
      fns: { get() {}, set(o: unknown) { return o; } },
      kind: "new",
    }),
  });
  await assert.rejects(
    () => runUpstream(parseCli(["upstream"]), deps),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL,
  );
  const evidence = JSON.parse(readFileSync(join(root, ".slim", "lodash", "evidence.json"), "utf8")) as {
    envelopeHash: string;
    byteDelta: { originalMin: number | null };
    generation: { kind: string; catalogIds: string[] };
  };
  assert.equal(typeof evidence.byteDelta.originalMin, "number");
  assert.ok((evidence.byteDelta.originalMin as number) > 0);
  assert.equal(evidence.generation.kind, "catalog");
  assert.ok(evidence.generation.catalogIds.length > 0);
  const env = JSON.parse(readFileSync(join(root, ".slim", "lodash", "envelope.json"), "utf8")) as Envelope;
  assert.equal(evidence.envelopeHash, hashEnvelope(env));
});

test("missing named export fails regen and writes nothing", async () => {
  const { root, moduleRel } = writeFixture();
  const before = readFileSync(join(root, moduleRel), "utf8");
  const deps = baseDeps({
    cwd: root,
    queryOsv: async () => sourceOk([CWE_1321]),
    assembleCatalogModule: () => "export function debounce() { return; }\n",
  });
  await assert.rejects(
    () => runUpstream(parseCli(["upstream"]), deps),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL && /export/i.test(err.message),
  );
  assert.equal(readFileSync(join(root, moduleRel), "utf8"), before);
});

test("merge-gate failure under --json keeps TAP off stdout", async () => {
  const { root } = writeFixture({ slimJson: true });
  writeFileSync(join(root, "merge-fail.js"), "process.stdout.write('ok 1 - tap\\n'); process.exit(1);\n");
  const slim = JSON.parse(readFileSync(join(root, "slim.json"), "utf8")) as {
    testCommand?: string;
    replacements: Record<string, unknown>;
    outDir?: string;
  };
  slim.testCommand = "node merge-fail.js";
  writeFileSync(join(root, "slim.json"), JSON.stringify(slim));
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(
      parseCli(["upstream", "--json"]),
      baseDeps({
        cwd: root,
        queryOsv: async () => sourceOk([CWE_1321]),
      }),
    ),
  );
  assert.equal(code, EXIT_FAIL);
  assert.doesNotMatch(stdout, /ok 1 - tap/);
  assert.match(stderr, /ok 1 - tap|merge gate/i);
  const doc = JSON.parse(stdout) as {
    conclusion: string;
    action: string;
    error?: string;
    findings: { exposure: string }[];
    regeneration: unknown[];
  };
  assert.equal(doc.conclusion, "exposed");
  assert.equal(doc.action, "blocked");
  assert.match(doc.error ?? "", /merge gate/i);
  assert.equal(doc.findings[0]?.exposure, "exposed");
  assert.deepEqual(doc.regeneration, []);
});

test("export failure under --json is an upstream document, not error schema", async () => {
  const { root, moduleRel } = writeFixture();
  const before = readFileSync(join(root, moduleRel), "utf8");
  const { code, stdout } = await capture(() =>
    runUpstream(
      parseCli(["upstream", "--json"]),
      baseDeps({
        cwd: root,
        queryOsv: async () => sourceOk([CWE_1321]),
        assembleCatalogModule: () => "export function debounce() { return; }\n",
      }),
    ),
  );
  assert.equal(code, EXIT_FAIL);
  assert.equal(readFileSync(join(root, moduleRel), "utf8"), before);
  const doc = JSON.parse(stdout) as { conclusion: string; action: string; error?: string; findings: unknown[] };
  assert.equal(doc.conclusion, "exposed");
  assert.equal(doc.action, "blocked");
  assert.match(doc.error ?? "", /export/i);
  assert.ok(Array.isArray(doc.findings) && doc.findings.length > 0);
});

test("exposed regen --json reports action regenerated", async () => {
  const { root } = writeFixture({ slimJson: true });
  const { code, stdout, stderr } = await capture(() =>
    runUpstream(
      parseCli(["upstream", "--json"]),
      baseDeps({
        cwd: root,
        queryOsv: async () => sourceOk([CWE_1321]),
      }),
    ),
  );
  assert.equal(code, EXIT_FAIL);
  const doc = JSON.parse(stdout) as {
    conclusion: string;
    action: string;
    regeneration: { package: string; regenerated: boolean; residualRisk: string[] }[];
  };
  assert.equal(doc.conclusion, "exposed");
  assert.equal(doc.action, "regenerated");
  assert.equal(doc.regeneration[0]?.regenerated, true);
  assert.ok(Array.isArray(doc.regeneration[0]?.residualRisk));
  assert.match(stderr, /regenerated/);
});

test("successful empty advisory --json includes action none", async () => {
  const { root } = writeFixture();
  const { code, stdout } = await capture(() =>
    runUpstream(parseCli(["upstream", "--json"]), baseDeps({ cwd: root })),
  );
  assert.equal(code, EXIT_OK);
  const doc = JSON.parse(stdout) as {
    conclusion: string;
    action: string;
    regeneration: unknown[];
    sources: { osv: { status: string }; npm: { status: string } };
  };
  assert.equal(doc.conclusion, "not-exposed");
  assert.equal(doc.action, "none");
  assert.equal(doc.sources.osv.status, "success");
  assert.equal(doc.sources.npm.status, "success");
  assert.deepEqual(doc.regeneration, []);
});
