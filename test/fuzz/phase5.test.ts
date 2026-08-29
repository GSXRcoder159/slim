import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  ENVELOPE_VERSION,
  emptyHyrum,
  type Envelope,
  type SymbolEnvelope,
} from "../../src/envelope/types.ts";
import { EXIT_ENV, EXIT_FAIL, SlimExit } from "../../src/exit.ts";
import { BUDGET_SLACK_MS, STARTUP_MS, SHUTDOWN_MS, wallMs } from "../../src/fuzz/clock.ts";
import { defaultWorkerCount, runFuzz, type FuzzReport } from "../../src/fuzz/run.ts";
import {
  createPool,
  JOB_TIMEOUT_CAP_MS,
  toCloneableJob,
  workerExecArgv,
  workerThreadUrl,
} from "../../src/fuzz/workers.ts";

test("workerExecArgv drops Node 24 runner flags that Worker rejects", () => {
  const argv = [
    "--experimental-strip-types",
    "--test",
    "--test-reporter=spec",
    "--v8-pool-size=4",
    "--trace-event-file-pattern=node_trace.${rotation}.log",
    "--secure-heap-min=2",
    "--tls-cipher-list=TLS_AES_128_GCM_SHA256",
    "--use-largepages=off",
    "--secure-heap=0",
    "--node-snapshot",
    "--stack-trace-limit=10",
    "--import",
    "./hook.js",
  ];
  assert.deepEqual(workerExecArgv(argv), [
    "--experimental-strip-types",
    "--import",
    "./hook.js",
  ]);
});

const ID_DEBOUNCE_SRC = `
export function id(x) { return x; }
export function debounce(fn, wait) {
  let t = null;
  function wrapped(...args) {
    if (t != null) clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  }
  wrapped.cancel = function () { if (t != null) clearTimeout(t); t = null; };
  wrapped.flush = function () { return undefined; };
  return wrapped;
}
`;

function loc() {
  return { file: "t.ts", line: 1, column: 0, endLine: 1, endColumn: 10 };
}

function baseEnvelope(over: Partial<Envelope> = {}): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: "lodash", version: "4.17.21", family: "lodash", subpath: "." },
    env: ["node"],
    imports: [],
    symbols: [],
    unknowns: [],
    traces: [],
    closure: {
      confidence: "closed",
      readyToGenerate: true,
      staticCallSiteIds: [],
      tracedCallSiteIds: [],
      untracedCallSiteIds: [],
      reason: "phase5",
    },
    slimmable: { score: 1, verdict: "slim", blockers: [], reasons: [] },
    clock: false,
    cryptoRandom: false,
    ...over,
  };
}

function valueSym(name: string, sites: SymbolEnvelope["callSites"]): SymbolEnvelope {
  return {
    exportName: name,
    packages: [{ name: "lodash", version: "4.17.21", family: "lodash", subpath: "." }],
    callSites: sites,
    resultMembers: [],
    hyrum: emptyHyrum(),
    coverage: { callSitesStatic: sites.length, callSitesTraced: 0 },
  };
}

function writePair(src: string): { orig: string; slim: string } {
  const dir = mkdtempSync(join(tmpdir(), "slim-p5-"));
  const orig = join(dir, "orig.mjs");
  const slim = join(dir, "slim.mjs");
  writeFileSync(orig, src);
  writeFileSync(slim, src);
  return { orig, slim };
}

function getCorrect(object: unknown, path: unknown, defaultValue?: unknown): unknown {
  if (object == null) return defaultValue;
  const segs = Array.isArray(path) ? path.map((x) => `${x}`) : `${path}`.split(".").filter(Boolean);
  let cur: unknown = object;
  for (const p of segs) {
    if (cur == null) return defaultValue;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur === undefined ? defaultValue : cur;
}

function getBad(object: unknown, path: unknown, defaultValue?: unknown): unknown {
  if (object == null) return defaultValue;
  if (object !== null && typeof object === "object" && typeof path === "string") {
    const v = (object as Record<string, unknown>)[path];
    return v === undefined ? defaultValue : v;
  }
  return defaultValue;
}

const getEnvelope = (): Envelope =>
  baseEnvelope({
    traces: [
      {
        symbol: "get",
        args: [
          {
            t: "obj",
            keys: ["a"],
            v: { a: { t: "obj", keys: ["b"], v: { b: { t: "num", v: 1 } } } },
          },
          { t: "str", v: "a.b" },
        ],
      },
    ],
    symbols: [
      valueSym("get", [
        {
          id: "c1",
          loc: loc(),
          exportName: "get",
          memberPath: ["get"],
          thisBinding: { kind: "unbound" },
          argc: { min: 2, max: 3, observed: [2, 3] },
          argShapes: [
            { kind: "object", props: { a: { kind: "object", props: { b: { kind: "literal", literals: [1] } } } } },
            { kind: "literal", literals: ["a.b", "a"] },
            { kind: "literal", literals: [undefined, "fallback"] },
          ],
          spread: false,
          resultMembers: [],
        },
      ]),
    ],
  });

test(
  "100ms clock fuzz with origModule workers=1 terminates within budget+slack",
  { timeout: 8000 },
  async () => {
    const { orig, slim } = writePair(ID_DEBOUNCE_SRC);
    const env = baseEnvelope({
      clock: true,
      symbols: [
        valueSym("id", [
          {
            id: "i1",
            loc: loc(),
            exportName: "id",
            memberPath: ["id"],
            thisBinding: { kind: "unbound" },
            argc: { min: 1, max: 1, observed: [1] },
            argShapes: [{ kind: "any" }],
            spread: false,
            resultMembers: [],
          },
        ]),
        {
          ...valueSym("debounce", [
            {
              id: "d1",
              loc: loc(),
              exportName: "debounce",
              memberPath: ["debounce"],
              thisBinding: { kind: "unbound" },
              argc: { min: 2, max: 2, observed: [2] },
              argShapes: [
                { kind: "function", fnArity: 0 },
                { kind: "literal", literals: [32] },
              ],
              spread: false,
              resultMembers: ["cancel", "flush"],
            },
          ]),
          resultMembers: ["cancel", "flush"],
        },
      ],
    });
    const report = await runFuzz({
      origModule: orig,
      slimModule: slim,
      envelope: env,
      budgetMs: 100,
      seed: 1,
      workers: 1,
    });
    assert.ok(report.cases > 0);
    assert.ok(report.timerCases > 0);
    assert.equal(report.disagreements.length, 0);
  },
);

test(
  "100ms clock fuzz with workers=2 terminates and closes",
  { timeout: 8000 },
  async () => {
    const { orig, slim } = writePair(ID_DEBOUNCE_SRC);
    const env = baseEnvelope({
      clock: true,
      symbols: [
        valueSym("id", [
          {
            id: "i1",
            loc: loc(),
            exportName: "id",
            memberPath: ["id"],
            thisBinding: { kind: "unbound" },
            argc: { min: 1, max: 1, observed: [1] },
            argShapes: [{ kind: "any" }],
            spread: false,
            resultMembers: [],
          },
        ]),
      ],
    });
    const report = await runFuzz({
      origModule: orig,
      slimModule: slim,
      envelope: env,
      budgetMs: 100,
      seed: 2,
      workers: 2,
    });
    assert.ok(report.cases > 0);
    assert.equal(report.disagreements.length, 0);
  },
);

test("orig mutating thisArg does not change slim's receiver", async () => {
  function bump(this: { n: number }) {
    this.n += 1;
    return this.n;
  }
  const report = await runFuzz({
    original: { bump },
    replacement: { bump },
    envelope: baseEnvelope({
      traces: [
        {
          symbol: "bump",
          args: [],
          thisArg: { t: "obj", keys: ["n"], v: { n: { t: "num", v: 0 } } },
        },
      ],
      symbols: [
        valueSym("bump", [
          {
            id: "b1",
            loc: loc(),
            exportName: "bump",
            memberPath: ["bump"],
            thisBinding: { kind: "method" },
            argc: { min: 0, max: 0, observed: [0] },
            argShapes: [],
            spread: false,
            resultMembers: [],
          },
        ]),
      ],
    }),
    budgetMs: 40,
    seed: 3,
    workers: 1,
  });
  assert.equal(report.disagreements.length, 0);
});

test("observed argc 2 is generated; not always 3 with undefined", async () => {
  const report = await runFuzz({
    original: { arity: (...a: unknown[]) => a.length },
    replacement: { arity: () => 3 },
    envelope: baseEnvelope({
      symbols: [
        valueSym("arity", [
          {
            id: "a1",
            loc: loc(),
            exportName: "arity",
            memberPath: ["arity"],
            thisBinding: { kind: "unbound" },
            argc: { min: 2, max: 2, observed: [2] },
            argShapes: [{ kind: "any" }, { kind: "any" }, { kind: "any" }],
            spread: false,
            resultMembers: [],
          },
        ]),
      ],
    }),
    budgetMs: 40,
    seed: 4,
    workers: 1,
  });
  assert.ok(report.disagreements.length > 0, "argc=2 must be generated");
});

test("second call-site shape family participates in generation", async () => {
  const report = await runFuzz({
    original: { echo: (x: unknown) => x },
    replacement: { echo: (x: unknown) => (x === "SITE_TWO" ? "NO" : x) },
    envelope: baseEnvelope({
      symbols: [
        valueSym("echo", [
          {
            id: "c1",
            loc: loc(),
            exportName: "echo",
            memberPath: ["echo"],
            thisBinding: { kind: "unbound" },
            argc: { min: 1, max: 1, observed: [1] },
            argShapes: [{ kind: "literal", literals: ["keep"] }],
            spread: false,
            resultMembers: [],
          },
          {
            id: "c2",
            loc: loc(),
            exportName: "echo",
            memberPath: ["echo"],
            thisBinding: { kind: "unbound" },
            argc: { min: 1, max: 1, observed: [1] },
            argShapes: [{ kind: "literal", literals: ["SITE_TWO"] }],
            spread: false,
            resultMembers: [],
          },
        ]),
      ],
    }),
    budgetMs: 40,
    seed: 5,
    workers: 1,
  });
  assert.ok(report.disagreements.length > 0);
  assert.ok(report.disagreements.some((d) => d.args.includes("SITE_TWO") || d.minimized?.includes("SITE_TWO")));
});

test("array element shapes are generated", async () => {
  const report = await runFuzz({
    original: { first: (a: unknown[]) => a[0] },
    replacement: { first: (a: unknown[]) => (a[0] === "ELEM_ONLY" ? "NO" : a[0]) },
    envelope: baseEnvelope({
      symbols: [
        valueSym("first", [
          {
            id: "f1",
            loc: loc(),
            exportName: "first",
            memberPath: ["first"],
            thisBinding: { kind: "unbound" },
            argc: { min: 1, max: 1, observed: [1] },
            argShapes: [{ kind: "array", elements: [{ kind: "literal", literals: ["ELEM_ONLY"] }] }],
            spread: false,
            resultMembers: [],
          },
        ]),
      ],
    }),
    budgetMs: 40,
    seed: 6,
    workers: 1,
  });
  assert.ok(report.disagreements.length > 0);
});

test("result-member traces are not replayed as export calls", async () => {
  function debounce(fn: unknown, wait: unknown) {
    if (fn === "MUST_NOT_SEE") return "LEAK";
    let t: ReturnType<typeof setTimeout> | null = null;
    const wrapped = (...args: unknown[]) => {
      if (t) clearTimeout(t);
      t = setTimeout(() => (fn as Function).apply(undefined, args), Number(wait) || 0);
    };
    (wrapped as { cancel: () => void }).cancel = () => {
      if (t) clearTimeout(t);
    };
    (wrapped as { flush: () => undefined }).flush = () => undefined;
    return wrapped;
  }
  const report = await runFuzz({
    original: { debounce },
    replacement: { debounce },
    envelope: baseEnvelope({
      clock: true,
      traces: [
        {
          symbol: "debounce.flush",
          args: [{ t: "str", v: "MUST_NOT_SEE" }],
          parentOriginId: "p",
          resultMember: "flush",
        },
      ],
      symbols: [
        {
          ...valueSym("debounce", [
            {
              id: "d1",
              loc: loc(),
              exportName: "debounce",
              memberPath: ["debounce"],
              thisBinding: { kind: "unbound" },
              argc: { min: 2, max: 2, observed: [2] },
              argShapes: [
                { kind: "function", fnArity: 0 },
                { kind: "literal", literals: [32] },
              ],
              spread: false,
              resultMembers: ["cancel", "flush"],
            },
          ]),
          resultMembers: ["cancel", "flush"],
        },
      ],
    }),
    budgetMs: 50,
    seed: 7,
    workers: 1,
  });
  assert.equal(report.tracesReplayed, 0);
  assert.ok(report.timerCases > 0);
  assert.equal(report.disagreements.length, 0);
});

test("projectRoot not cwd decides which oracle is loaded", async () => {
  const target = mkdtempSync(join(tmpdir(), "slim-ora-t-"));
  const decoy = mkdtempSync(join(tmpdir(), "slim-ora-d-"));
  writeFileSync(join(target, "package.json"), JSON.stringify({ name: "app", type: "commonjs" }));
  writeFileSync(join(decoy, "package.json"), JSON.stringify({ name: "decoy", type: "commonjs" }));
  for (const [root, value] of [
    [target, "target-v"],
    [decoy, "decoy-v"],
  ] as const) {
    const dir = join(root, "node_modules", "slim-oracle-probe");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "slim-oracle-probe", version: "1.0.0" }));
    writeFileSync(join(dir, "index.js"), `module.exports = { id() { return ${JSON.stringify(value)}; } };\n`);
  }
  const slimDir = mkdtempSync(join(tmpdir(), "slim-ora-s-"));
  const slim = join(slimDir, "slim.mjs");
  writeFileSync(slim, `export function id() { return "target-v"; }\n`);
  const env = baseEnvelope({
    package: { name: "slim-oracle-probe", version: "1.0.0", family: "slim-oracle-probe", subpath: "." },
    symbols: [
      valueSym("id", [
        {
          id: "c1",
          loc: loc(),
          exportName: "id",
          memberPath: ["id"],
          thisBinding: { kind: "unbound" },
          argc: { min: 0, max: 0, observed: [0] },
          argShapes: [],
          spread: false,
          resultMembers: [],
        },
      ]),
    ],
    traces: [{ symbol: "id", args: [] }],
  });
  const prev = process.cwd();
  try {
    process.chdir(decoy);
    const hit = await runFuzz({
      origModule: "slim-oracle-probe",
      slimModule: slim,
      envelope: env,
      budgetMs: 30,
      seed: 8,
      workers: 1,
      projectRoot: target,
    });
    assert.equal(hit.disagreements.length, 0, hit.disagreements.map((d) => d.reason).join("; "));

    const miss = await runFuzz({
      origModule: "slim-oracle-probe",
      slimModule: slim,
      envelope: env,
      budgetMs: 30,
      seed: 8,
      workers: 1,
      projectRoot: decoy,
    });
    assert.ok(miss.disagreements.length > 0, "decoy oracle must disagree with target slim");
  } finally {
    process.chdir(prev);
  }
});

test("missing orig function fails immediately", async () => {
  await assert.rejects(
    () =>
      runFuzz({
        original: {},
        replacement: { get: getCorrect },
        envelope: getEnvelope(),
        budgetMs: 20,
        seed: 1,
        workers: 1,
      }),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_FAIL && /missing function get/.test(e.message),
  );
});

test("missing replacement function fails immediately in the pool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-miss-"));
  const orig = join(dir, "orig.mjs");
  const slim = join(dir, "slim.mjs");
  writeFileSync(orig, "export function get() { return 1; }\n");
  writeFileSync(slim, "export function other() { return 1; }\n");
  await assert.rejects(
    () =>
      runFuzz({
        origModule: orig,
        slimModule: slim,
        envelope: getEnvelope(),
        budgetMs: 40,
        seed: 1,
        workers: 2,
      }),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_FAIL && /missing function get/.test(e.message),
  );
});

test("same seed reproduces disagreement and minimized payload", async () => {
  const opts = {
    original: { get: getCorrect },
    replacement: { get: getBad },
    envelope: getEnvelope(),
    budgetMs: 80,
    seed: 42,
    workers: 1 as const,
  };
  const a = await runFuzz(opts);
  const b = await runFuzz(opts);
  assert.ok(a.disagreements.length > 0);
  assert.equal(a.disagreements[0]!.symbol, b.disagreements[0]!.symbol);
  assert.equal(a.disagreements[0]!.reason, b.disagreements[0]!.reason);
  assert.deepEqual(a.disagreements[0]!.minimized, b.disagreements[0]!.minimized);
  assert.ok(a.disagreements[0]!.minimized !== undefined);
});

test("worker-pool disagreements include minimized inputs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-min-"));
  const orig = join(dir, "orig.mjs");
  const slim = join(dir, "slim.mjs");
  writeFileSync(
    orig,
    `export function get(object, path, d) {
      if (object == null) return d;
      const segs = String(path).split(".").filter(Boolean);
      let cur = object;
      for (const p of segs) { if (cur == null) return d; cur = cur[p]; }
      return cur === undefined ? d : cur;
    }\n`,
  );
  writeFileSync(
    slim,
    `export function get(object, path, d) {
      if (object == null) return d;
      if (typeof path === "string") {
        const v = object[path];
        return v === undefined ? d : v;
      }
      return d;
    }\n`,
  );
  const report = await runFuzz({
    origModule: orig,
    slimModule: slim,
    envelope: getEnvelope(),
    budgetMs: 120,
    seed: 42,
    workers: 2,
  });
  assert.ok(report.disagreements.length > 0);
  assert.ok(
    report.disagreements.some((d) => d.minimized !== undefined),
    "pool disagreements must include minimized",
  );
});

test("uuid-style crypto isolation makes identical readers agree", async () => {
  function rand() {
    const u = new Uint8Array(1);
    crypto.getRandomValues(u);
    return u[0];
  }
  const env = baseEnvelope({
    package: { name: "uuid", version: "9.0.0", family: "uuid", subpath: "." },
    cryptoRandom: true,
    traces: [{ symbol: "rand", args: [] }],
    symbols: [
      valueSym("rand", [
        {
          id: "r1",
          loc: loc(),
          exportName: "rand",
          memberPath: ["rand"],
          thisBinding: { kind: "unbound" },
          argc: { min: 0, max: 0, observed: [0] },
          argShapes: [],
          spread: false,
          resultMembers: [],
        },
      ]),
    ],
  });
  const report = await runFuzz({
    original: { rand },
    replacement: { rand },
    envelope: env,
    budgetMs: 40,
    seed: 9,
    workers: 1,
  });
  assert.equal(report.disagreements.length, 0, report.disagreements.map((d) => d.reason).join("; "));
  assert.equal(report.allowFlaky, false);
});

test("worker crash is EXIT_ENV and pool closes", { timeout: 8000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-crash-"));
  const orig = join(dir, "orig.mjs");
  const slim = join(dir, "slim.mjs");
  writeFileSync(orig, "export function id() { process.exit(1); }\n");
  writeFileSync(slim, "export function id() { return 1; }\n");
  const env = baseEnvelope({
    traces: [{ symbol: "id", args: [] }],
    symbols: [
      valueSym("id", [
        {
          id: "c1",
          loc: loc(),
          exportName: "id",
          memberPath: ["id"],
          thisBinding: { kind: "unbound" },
          argc: { min: 0, max: 0, observed: [0] },
          argShapes: [],
          spread: false,
          resultMembers: [],
        },
      ]),
    ],
  });
  await assert.rejects(
    () =>
      runFuzz({
        origModule: orig,
        slimModule: slim,
        envelope: env,
        budgetMs: 80,
        seed: 1,
        workers: 2,
      }),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_ENV,
  );
});

test("worker timeout is EXIT_ENV", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-hang-"));
  const orig = join(dir, "orig.mjs");
  const slim = join(dir, "slim.mjs");
  writeFileSync(orig, "export function id() { for (;;) {} }\n");
  writeFileSync(slim, "export function id() { return 1; }\n");
  const env = baseEnvelope({
    traces: [{ symbol: "id", args: [] }],
    symbols: [
      valueSym("id", [
        {
          id: "c1",
          loc: loc(),
          exportName: "id",
          memberPath: ["id"],
          thisBinding: { kind: "unbound" },
          argc: { min: 0, max: 0, observed: [0] },
          argShapes: [],
          spread: false,
          resultMembers: [],
        },
      ]),
    ],
  });
  await assert.rejects(
    () =>
      runFuzz({
        origModule: orig,
        slimModule: slim,
        envelope: env,
        budgetMs: 80,
        seed: 1,
        workers: 2,
      }),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_ENV && /timeout/i.test((e as Error).message),
  );
});

test("non-cloneable job is EXIT_FAIL serialization failure", async () => {
  const { orig, slim } = writePair("export function id() { return 1; }\n");
  const bomb: Record<string, unknown> = {};
  Object.defineProperty(bomb, "x", {
    enumerable: true,
    get() {
      throw new Error("nope");
    },
  });
  const pool = createPool({
    workers: 2,
    origModule: orig,
    slimModule: slim,
    symbols: ["id"],
    timeoutMs: 500,
  });
  try {
    await assert.rejects(
      () => pool.runCase({ symbol: "id", args: [bomb], kind: "call" }),
      (e: unknown) => e instanceof SlimExit && e.code === EXIT_FAIL && /serialization/i.test((e as Error).message),
    );
  } finally {
    await pool.close();
  }
});

test("worker-thread posts error on malformed run message", { timeout: 8000 }, async () => {
  const { orig, slim } = writePair("export function id() { return 1; }\n");
  const w = new Worker(workerThreadUrl(), {
    execArgv: workerExecArgv(),
    workerData: {
      origModule: orig,
      slimModule: pathToFileURL(slim).href,
      clock: false,
    },
  });
  try {
    const msg = await new Promise<{ type: string; error?: string }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no malformed reply")), 3000);
      w.on("message", (m: { type: string; error?: string }) => {
        if (m.type === "ready") return;
        clearTimeout(t);
        resolve(m);
      });
      w.once("error", reject);
      w.postMessage({ type: "run", id: 1 });
    });
    assert.equal(msg.type, "error");
    assert.match(msg.error ?? "", /malformed/);
  } finally {
    await w.terminate();
  }
});

test("toCloneableJob still roundtrips a normal call", () => {
  const wired = toCloneableJob({ symbol: "id", args: [1, "x"], kind: "call" });
  assert.equal((wired.args[0] as { t?: string }).t, "num");
});

const ID_SRC = "export function id(x) { return x; }\n";

function idEnvelope(): Envelope {
  return baseEnvelope({
    traces: [{ symbol: "id", args: [{ t: "num", v: 1 }] }],
    symbols: [
      valueSym("id", [
        {
          id: "c1",
          loc: loc(),
          exportName: "id",
          memberPath: ["id"],
          thisBinding: { kind: "unbound" },
          argc: { min: 1, max: 1, observed: [1] },
          argShapes: [{ kind: "literal", literals: [1, 2, 3] }],
          spread: false,
          resultMembers: [],
        },
      ]),
    ],
  });
}

function comparable(r: FuzzReport) {
  return {
    cases: r.cases,
    comparisons: r.comparisons,
    timerCases: r.timerCases,
    tracesReplayed: r.tracesReplayed,
    seed: r.seed,
    allowFlaky: r.allowFlaky,
    disagreements: r.disagreements,
  };
}

function writeGetPair(): { orig: string; slim: string } {
  const dir = mkdtempSync(join(tmpdir(), "slim-p5-get-"));
  const orig = join(dir, "orig.mjs");
  const slim = join(dir, "slim.mjs");
  writeFileSync(
    orig,
    `export function get(object, path, d) {
      if (object == null) return d;
      const segs = String(path).split(".").filter(Boolean);
      let cur = object;
      for (const p of segs) { if (cur == null) return d; cur = cur[p]; }
      return cur === undefined ? d : cur;
    }\n`,
  );
  writeFileSync(
    slim,
    `export function get(object, path, d) {
      if (object == null) return d;
      if (typeof path === "string") {
        const v = object[path];
        return v === undefined ? d : v;
      }
      return d;
    }\n`,
  );
  return { orig, slim };
}

test(
  "same seed and budget reproduce cases and ordered disagreements for workers 1, 2, and default",
  { timeout: 30_000 },
  async () => {
    const { orig, slim } = writeGetPair();
    const counts = [...new Set([1, 2, defaultWorkerCount()])];
    for (const workers of counts) {
      const opts = {
        origModule: orig,
        slimModule: slim,
        envelope: getEnvelope(),
        budgetMs: 20,
        seed: 42,
        workers,
      };
      const a = await runFuzz(opts);
      const b = await runFuzz(opts);
      assert.ok(a.cases > 0, `workers=${workers} ran no cases`);
      assert.deepEqual(comparable(a), comparable(b), `workers=${workers} rerun diverged`);
    }
  },
);

test(
  "workers 1 and 2 produce the same work set for the same seed and budget",
  { timeout: 20_000 },
  async () => {
    const { orig, slim } = writeGetPair();
    const opts = {
      origModule: orig,
      slimModule: slim,
      envelope: getEnvelope(),
      budgetMs: 20,
      seed: 7,
    };
    const one = await runFuzz({ ...opts, workers: 1 });
    const two = await runFuzz({ ...opts, workers: 2 });
    assert.deepEqual(comparable(one), comparable(two));
  },
);

test(
  "slow worker import does not consume a short case timeout",
  { timeout: 8000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "slim-p5-slow-"));
    const orig = join(dir, "orig.mjs");
    const slim = join(dir, "slim.mjs");
    writeFileSync(
      orig,
      `await new Promise((r) => setTimeout(r, 200));
export function id(x) { return x; }
`,
    );
    writeFileSync(slim, ID_SRC);
    const report = await runFuzz({
      origModule: orig,
      slimModule: slim,
      envelope: idEnvelope(),
      budgetMs: 80,
      seed: 1,
      workers: 2,
    });
    assert.ok(report.cases > 0);
    assert.equal(report.disagreements.length, 0, report.disagreements.map((d) => d.reason).join("; "));
  },
);

test("insufficient startup is EXIT_ENV and distinct from timeout", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-p5-hangload-"));
  const orig = join(dir, "orig.mjs");
  const slim = join(dir, "slim.mjs");
  writeFileSync(orig, "await new Promise(() => {});\nexport function id() { return 1; }\n");
  writeFileSync(slim, ID_SRC);
  await assert.rejects(
    () =>
      runFuzz({
        origModule: orig,
        slimModule: slim,
        envelope: idEnvelope(),
        budgetMs: 80,
        seed: 1,
        workers: 2,
      }),
    (e: unknown) =>
      e instanceof SlimExit &&
      e.code === EXIT_ENV &&
      /insufficient startup/i.test(e.message) &&
      !/timeout/i.test(e.message),
  );
});

test("empty work set with zero extra quota is insufficient budget", async () => {
  await assert.rejects(
    () =>
      runFuzz({
        original: { id: (x: unknown) => x },
        replacement: { id: (x: unknown) => x },
        envelope: baseEnvelope({
          symbols: [valueSym("id", [])],
        }),
        budgetMs: 0,
        seed: 1,
        workers: 1,
      }),
    (e: unknown) =>
      e instanceof SlimExit && e.code === EXIT_ENV && /insufficient budget/i.test(e.message),
  );
});

test("hung worker timeout then a healthy run still works", { timeout: 25_000 }, async () => {
  const hung = mkdtempSync(join(tmpdir(), "slim-p5-hung2-"));
  writeFileSync(join(hung, "orig.mjs"), "export function id() { for (;;) {} }\n");
  writeFileSync(join(hung, "slim.mjs"), ID_SRC);
  const env = idEnvelope();
  const t0 = wallMs();
  await assert.rejects(
    () =>
      runFuzz({
        origModule: join(hung, "orig.mjs"),
        slimModule: join(hung, "slim.mjs"),
        envelope: env,
        budgetMs: 80,
        seed: 1,
        workers: 2,
      }),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_ENV && /timeout/i.test(e.message),
  );
  const elapsed = wallMs() - t0;
  assert.ok(
    elapsed <= STARTUP_MS + JOB_TIMEOUT_CAP_MS + SHUTDOWN_MS + BUDGET_SLACK_MS,
    `hung worker overran documented bound: ${elapsed}ms`,
  );
  const { orig, slim } = writePair(ID_SRC);
  const healthy = await runFuzz({
    origModule: orig,
    slimModule: slim,
    envelope: env,
    budgetMs: 20,
    seed: 2,
    workers: 2,
  });
  assert.ok(healthy.cases > 0);
});

test("returned pool report is frozen after close", { timeout: 8000 }, async () => {
  const { orig, slim } = writePair(ID_SRC);
  const report = await runFuzz({
    origModule: orig,
    slimModule: slim,
    envelope: idEnvelope(),
    budgetMs: 10,
    seed: 3,
    workers: 2,
  });
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.disagreements));
});

test("crash, serialize, hang, and startup failures have distinct messages", { timeout: 30_000 }, async () => {
  const crashDir = mkdtempSync(join(tmpdir(), "slim-p5-c-"));
  writeFileSync(join(crashDir, "orig.mjs"), "export function id() { process.exit(1); }\n");
  writeFileSync(join(crashDir, "slim.mjs"), ID_SRC);
  const hangDir = mkdtempSync(join(tmpdir(), "slim-p5-h-"));
  writeFileSync(join(hangDir, "orig.mjs"), "export function id() { for (;;) {} }\n");
  writeFileSync(join(hangDir, "slim.mjs"), ID_SRC);
  const loadDir = mkdtempSync(join(tmpdir(), "slim-p5-l-"));
  writeFileSync(join(loadDir, "orig.mjs"), "await new Promise(() => {});\nexport function id() { return 1; }\n");
  writeFileSync(join(loadDir, "slim.mjs"), ID_SRC);
  const env = idEnvelope();

  const crash = await runFuzz({
    origModule: join(crashDir, "orig.mjs"),
    slimModule: join(crashDir, "slim.mjs"),
    envelope: env,
    budgetMs: 80,
    seed: 1,
    workers: 2,
  }).then(
    () => null,
    (e: unknown) => e,
  );
  const hang = await runFuzz({
    origModule: join(hangDir, "orig.mjs"),
    slimModule: join(hangDir, "slim.mjs"),
    envelope: env,
    budgetMs: 80,
    seed: 1,
    workers: 2,
  }).then(
    () => null,
    (e: unknown) => e,
  );
  const startup = await runFuzz({
    origModule: join(loadDir, "orig.mjs"),
    slimModule: join(loadDir, "slim.mjs"),
    envelope: env,
    budgetMs: 80,
    seed: 1,
    workers: 2,
  }).then(
    () => null,
    (e: unknown) => e,
  );
  const { orig, slim } = writePair(ID_SRC);
  const bomb: Record<string, unknown> = {};
  Object.defineProperty(bomb, "x", {
    enumerable: true,
    get() {
      throw new Error("nope");
    },
  });
  const pool = createPool({
    workers: 2,
    origModule: orig,
    slimModule: slim,
    symbols: ["id"],
    timeoutMs: 500,
  });
  let serialize: unknown;
  try {
    serialize = await pool.runCase({ symbol: "id", args: [bomb], kind: "call" }).then(
      () => null,
      (e: unknown) => e,
    );
  } finally {
    await pool.close();
  }

  assert.ok(crash instanceof SlimExit && crash.code === EXIT_ENV && /crashed/i.test(crash.message));
  assert.ok(hang instanceof SlimExit && hang.code === EXIT_ENV && /timeout/i.test(hang.message));
  assert.ok(
    startup instanceof SlimExit &&
      startup.code === EXIT_ENV &&
      /insufficient startup/i.test(startup.message),
  );
  assert.ok(
    serialize instanceof SlimExit && serialize.code === EXIT_FAIL && /serialization/i.test(serialize.message),
  );
  const budget = await runFuzz({
    original: { id: (x: unknown) => x },
    replacement: { id: (x: unknown) => x },
    envelope: baseEnvelope({ symbols: [valueSym("id", [])] }),
    budgetMs: 0,
    seed: 1,
    workers: 1,
  }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(
    budget instanceof SlimExit && budget.code === EXIT_ENV && /insufficient budget/i.test(budget.message),
  );
  const msgs = [crash.message, hang.message, startup.message, serialize.message, budget.message];
  assert.equal(new Set(msgs).size, 5, `messages were not distinct: ${msgs.join(" | ")}`);
  assert.doesNotMatch(budget.message, /timeout/i);
});

test("worker-pool determinism holds across 10 serial repeats", { timeout: 30_000 }, async () => {
  const { orig, slim } = writePair(ID_SRC);
  const opts = {
    origModule: orig,
    slimModule: slim,
    envelope: idEnvelope(),
    budgetMs: 15,
    seed: 99,
    workers: 2 as const,
  };
  const first = comparable(await runFuzz(opts));
  assert.ok(first.cases > 0);
  for (let i = 0; i < 9; i++) {
    assert.deepEqual(comparable(await runFuzz(opts)), first, `repeat ${i + 2} diverged`);
  }
});

test("worker-thread posts ready after load", { timeout: 8000 }, async () => {
  const { orig, slim } = writePair(ID_SRC);
  const w = new Worker(workerThreadUrl(), {
    execArgv: workerExecArgv(),
    workerData: {
      origModule: orig,
      slimModule: pathToFileURL(slim).href,
      clock: false,
    },
  });
  try {
    const msg = await new Promise<{ type: string }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no ready")), 3000);
      w.once("message", (m: { type: string }) => {
        clearTimeout(t);
        resolve(m);
      });
      w.once("error", reject);
    });
    assert.equal(msg.type, "ready");
  } finally {
    await w.terminate();
  }
});

const SLOW_ID_SRC = `
export function id(x) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  return x;
}
`;

test(
  "progressing pool run is not aborted when wall time exceeds budget+startup+shutdown",
  { timeout: 30_000 },
  async () => {
    const { orig, slim } = writePair(SLOW_ID_SRC);
    const budgetMs = 10;
    const t0 = wallMs();
    const report = await runFuzz({
      origModule: orig,
      slimModule: slim,
      envelope: idEnvelope(),
      budgetMs,
      seed: 1,
      workers: 2,
    });
    const elapsed = wallMs() - t0;
    assert.ok(report.cases > 0, "planned cases must run");
    assert.equal(report.disagreements.length, 0, report.disagreements.map((d) => d.reason).join("; "));
    assert.ok(
      elapsed > budgetMs + STARTUP_MS + SHUTDOWN_MS,
      `expected wall ${elapsed}ms to exceed quota watchdog ${budgetMs + STARTUP_MS + SHUTDOWN_MS}`,
    );
    const again = await runFuzz({
      origModule: orig,
      slimModule: slim,
      envelope: idEnvelope(),
      budgetMs,
      seed: 1,
      workers: 2,
    });
    assert.deepEqual(comparable(report), comparable(again));
  },
);

async function withCpuBurn<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "slim-p5-burn-"));
  const src = join(dir, "burn.mjs");
  writeFileSync(
    src,
    `import { workerData } from "node:worker_threads";
const flag = new Int32Array(workerData);
while (Atomics.load(flag, 0) === 0) {
  for (let i = 0; i < 5e5; i++) {}
}
`,
  );
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const burners = [0, 1, 2, 3].map(
    () =>
      new Worker(src, {
        execArgv: workerExecArgv(),
        workerData: flag,
      }),
  );
  try {
    return await fn();
  } finally {
    Atomics.store(flag, 0, 1);
    await Promise.all(burners.map((w) => w.terminate()));
  }
}

test(
  "100ms budget fuzz under CPU contention still completes for workers 1 and 2",
  { timeout: 60_000 },
  async () => {
    await withCpuBurn(async () => {
      const debouncePair = writePair(ID_DEBOUNCE_SRC);
      const idPair = writePair(ID_SRC);
      const debounceEnv = baseEnvelope({
        clock: true,
        symbols: [
          valueSym("id", [
            {
              id: "i1",
              loc: loc(),
              exportName: "id",
              memberPath: ["id"],
              thisBinding: { kind: "unbound" },
              argc: { min: 1, max: 1, observed: [1] },
              argShapes: [{ kind: "any" }],
              spread: false,
              resultMembers: [],
            },
          ]),
        ],
      });
      const one = await runFuzz({
        origModule: debouncePair.orig,
        slimModule: debouncePair.slim,
        envelope: debounceEnv,
        budgetMs: 100,
        seed: 1,
        workers: 1,
      });
      const two = await runFuzz({
        origModule: idPair.orig,
        slimModule: idPair.slim,
        envelope: idEnvelope(),
        budgetMs: 100,
        seed: 2,
        workers: 2,
      });
      assert.ok(one.cases > 0);
      assert.equal(one.disagreements.length, 0);
      assert.ok(two.cases > 0);
      assert.equal(two.disagreements.length, 0);
    });
  },
);

function workerLikeResources(): string[] {
  const info =
    (process as NodeJS.Process & { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo?.() ??
    [];
  return info.filter((n) => n === "MessagePort" || /Worker/i.test(n));
}

test(
  "late result after case timeout does not resurrect the job",
  { timeout: 15_000 },
  async () => {
    const { orig, slim } = writePair(`
export function id(x) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  return x;
}
`);
    const pool = createPool({
      workers: 2,
      origModule: orig,
      slimModule: slim,
      symbols: ["id"],
      timeoutMs: 50,
    });
    try {
      await pool.ready();
      const first = await pool.runCase({ symbol: "id", args: [1], kind: "call" }).then(
        (r) => r,
        (e: unknown) => e,
      );
      assert.ok(
        first instanceof SlimExit && first.code === EXIT_ENV && /timeout/i.test(first.message),
      );
      await new Promise((r) => setTimeout(r, 400));
      const second = await pool.runCase({ symbol: "id", args: [1], kind: "call" }, 2000);
      assert.equal(second.ok, true);
      assert.ok(first instanceof SlimExit);
    } finally {
      await pool.close();
    }
  },
);

test(
  "close during hung case rejects in-flight work and leaves no live worker",
  { timeout: 15_000 },
  async () => {
    const hung = mkdtempSync(join(tmpdir(), "slim-p5-close-"));
    writeFileSync(join(hung, "orig.mjs"), "export function id() { for (;;) {} }\n");
    writeFileSync(join(hung, "slim.mjs"), ID_SRC);
    const before = workerLikeResources().length;
    const pool = createPool({
      workers: 2,
      origModule: join(hung, "orig.mjs"),
      slimModule: join(hung, "slim.mjs"),
      symbols: ["id"],
      timeoutMs: JOB_TIMEOUT_CAP_MS,
    });
    try {
      await pool.ready();
      const running = pool.runCase({ symbol: "id", args: [], kind: "call" }).then(
        (r) => r,
        (e: unknown) => e,
      );
      await new Promise((r) => setTimeout(r, 30));
      await pool.close();
      const err = await running;
      assert.ok(
        err instanceof SlimExit &&
          err.code === EXIT_ENV &&
          /pool closed|timeout/i.test(err.message),
      );
      await assert.rejects(
        () => pool.runCase({ symbol: "id", args: [], kind: "call" }),
        (e: unknown) => e instanceof SlimExit && /pool closed/i.test((e as Error).message),
      );
    } finally {
      await pool.close();
    }
    await new Promise((r) => setTimeout(r, 50));
    const after = workerLikeResources().length;
    assert.ok(after <= before, `leaked worker resources: before=${before} after=${after}`);
  },
);

test(
  "hung runFuzz cleanup leaves no extra worker resources",
  { timeout: 20_000 },
  async () => {
    const hung = mkdtempSync(join(tmpdir(), "slim-p5-reap-"));
    writeFileSync(join(hung, "orig.mjs"), "export function id() { for (;;) {} }\n");
    writeFileSync(join(hung, "slim.mjs"), ID_SRC);
    const before = workerLikeResources().length;
    await assert.rejects(
      () =>
        runFuzz({
          origModule: join(hung, "orig.mjs"),
          slimModule: join(hung, "slim.mjs"),
          envelope: idEnvelope(),
          budgetMs: 80,
          seed: 1,
          workers: 2,
        }),
      (e: unknown) => e instanceof SlimExit && /timeout/i.test((e as Error).message),
    );
    await new Promise((r) => setTimeout(r, 50));
    const after = workerLikeResources().length;
    assert.ok(after <= before, `leaked worker resources: before=${before} after=${after}`);
  },
);

test(
  "parallel runFuzz matches serial baseline for workers 1 and 2",
  { timeout: 30_000 },
  async () => {
    const { orig, slim } = writeGetPair();
    const opts = {
      origModule: orig,
      slimModule: slim,
      envelope: getEnvelope(),
      budgetMs: 20,
      seed: 42,
    };
    const serial1 = comparable(await runFuzz({ ...opts, workers: 1 }));
    const serial2 = comparable(await runFuzz({ ...opts, workers: 2 }));
    const [p1, p2] = await Promise.all([
      runFuzz({ ...opts, workers: 1 }),
      runFuzz({ ...opts, workers: 2 }),
    ]);
    assert.deepEqual(comparable(p1), serial1);
    assert.deepEqual(comparable(p2), serial2);
    assert.deepEqual(serial1, serial2);
  },
);
