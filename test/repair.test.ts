import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repairLoop } from "../src/generate/repair.ts";
import { SlimExit, EXIT_FAIL } from "../src/exit.ts";
import { ENVELOPE_VERSION, emptyHyrum } from "../src/envelope/types.ts";
import type { Envelope } from "../src/envelope/types.ts";

function linkTypescript(root: string) {
  const tsDir = dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
  mkdirSync(join(root, "node_modules"), { recursive: true });
  const dest = join(root, "node_modules", "typescript");
  if (!existsSync(dest)) symlinkSync(tsDir, dest);
}

function env(): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: "ms", version: "2", family: "ms", subpath: "" },
    env: ["node"],
    imports: [],
    symbols: [
      {
        exportName: "ms",
        packages: [],
        callSites: [],
        resultMembers: [],
        hyrum: emptyHyrum(),
        coverage: { callSitesStatic: 0, callSitesTraced: 0 },
      },
    ],
    unknowns: [],
    traces: [],
    closure: {
      confidence: "closed",
      readyToGenerate: true,
      staticCallSiteIds: [],
      tracedCallSiteIds: [],
      untracedCallSiteIds: [],
      reason: "",
    },
    slimmable: { score: 80, verdict: "slim", blockers: [], reasons: [] },
    clock: false,
    cryptoRandom: false,
  };
}

const llm = {
  baseUrl: "https://api.anthropic.com/v1/messages",
  model: "x",
  apiKey: "k",
  kind: "anthropic" as const,
};

const okSource = `export function ms(x: unknown) { return 1; }\n`;

test("repairLoop feeds counterexample into generate on disagreement", async () => {
  const root = mkdtempSync(join(tmpdir(), "slim-repair-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "slim", devDependencies: { typescript: "^5" } }));
  linkTypescript(root);
  const seen: string[][] = [];
  let n = 0;
  const out = await repairLoop({
    envelope: env(),
    publicApi: { text: "export function ms(x: unknown): number;", source: "bundled-dts" },
    initial: okSource,
    maxAttempts: 3,
    llm,
    projectRoot: root,
    catalog: false,
    fuzz: async () => {
      n++;
      if (n === 1) {
        return { disagreements: [{ symbol: "ms", args: ["1s"], reason: "1 !== 1000" }] };
      }
      return { disagreements: [] };
    },
    generate: async (_e, _p, examples) => {
      seen.push(examples);
      return { source: okSource, promptHash: "p" };
    },
  });
  assert.equal(out.attempts, 2);
  assert.equal(out.report.disagreements.length, 0);
  assert.equal(seen.length, 1);
  assert.match(seen[0]![0]!, /ms: 1 !== 1000/);
});

test("repairLoop does not LLM-patch catalog disagreements", async () => {
  const root = mkdtempSync(join(tmpdir(), "slim-repair-cat-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "slim", devDependencies: { typescript: "^5" } }));
  linkTypescript(root);
  let generated = 0;
  const out = await repairLoop({
    envelope: env(),
    publicApi: { text: "", source: "envelope-only", limitation: "none" },
    initial: okSource,
    maxAttempts: 3,
    llm,
    projectRoot: root,
    catalog: true,
    fuzz: async () => ({ disagreements: [{ symbol: "ms", args: [], reason: "bug" }] }),
    generate: async () => {
      generated++;
      return { source: okSource, promptHash: "p" };
    },
  });
  assert.equal(out.attempts, 1);
  assert.equal(generated, 0);
  assert.equal(out.report.disagreements.length, 1);
});

test("repairLoop feeds missing export into generate", async () => {
  const root = mkdtempSync(join(tmpdir(), "slim-repair-exp-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "slim", devDependencies: { typescript: "^5" } }));
  linkTypescript(root);
  const seen: string[][] = [];
  let fuzzed = 0;
  const out = await repairLoop({
    envelope: env(),
    publicApi: { text: "export function ms(): number;", source: "bundled-dts" },
    initial: `export function other() { return 1; }\n`,
    maxAttempts: 3,
    llm,
    projectRoot: root,
    catalog: false,
    fuzz: async () => {
      fuzzed++;
      return { disagreements: [] };
    },
    generate: async (_e, _p, examples) => {
      seen.push(examples);
      return { source: okSource, promptHash: "p" };
    },
  });
  assert.equal(out.attempts, 2);
  assert.equal(fuzzed, 1);
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.join("\n"), /missing named export ms/);
});

test("repairLoop preserves every counterexample across rounds", async () => {
  const root = mkdtempSync(join(tmpdir(), "slim-repair-all-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "slim", devDependencies: { typescript: "^5" } }));
  linkTypescript(root);
  const seen: string[][] = [];
  let n = 0;
  const out = await repairLoop({
    envelope: env(),
    publicApi: { text: "export function ms(): number;", source: "bundled-dts" },
    initial: okSource,
    maxAttempts: 3,
    llm,
    projectRoot: root,
    catalog: false,
    fuzz: async () => {
      n++;
      if (n === 1) return { disagreements: [{ symbol: "ms", args: [], reason: "first" }] };
      if (n === 2) return { disagreements: [{ symbol: "ms", args: [], reason: "second" }] };
      return { disagreements: [] };
    },
    generate: async (_e, _p, examples) => {
      seen.push([...examples]);
      return { source: okSource, promptHash: "p" };
    },
  });
  assert.equal(out.attempts, 3);
  assert.equal(seen.length, 2);
  assert.match(seen[1]!.join("\n"), /first/);
  assert.match(seen[1]!.join("\n"), /second/);
});

test("repairLoop exhaustion throws EXIT_FAIL with counterexamples", async () => {
  const root = mkdtempSync(join(tmpdir(), "slim-repair-exh-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "slim", devDependencies: { typescript: "^5" } }));
  linkTypescript(root);
  await assert.rejects(
    () =>
      repairLoop({
        envelope: env(),
        publicApi: { text: "export function ms(): number;", source: "bundled-dts" },
        initial: okSource,
        maxAttempts: 2,
        llm,
        projectRoot: root,
        catalog: false,
        fuzz: async () => ({ disagreements: [{ symbol: "ms", args: [], reason: "still wrong" }] }),
        generate: async () => ({ source: okSource, promptHash: "p" }),
      }),
    (err: unknown) => {
      assert.ok(err instanceof SlimExit);
      assert.equal(err.code, EXIT_FAIL);
      assert.match(err.message, /still wrong/);
      return true;
    },
  );
});

test("repairLoop does not repair unsafe AST", async () => {
  const root = mkdtempSync(join(tmpdir(), "slim-repair-eval-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "slim", devDependencies: { typescript: "^5" } }));
  linkTypescript(root);
  let generated = 0;
  await assert.rejects(
    () =>
      repairLoop({
        envelope: env(),
        publicApi: { text: "", source: "envelope-only" },
        initial: `export function ms() { return eval("1"); }\n`,
        maxAttempts: 3,
        llm,
        projectRoot: root,
        catalog: false,
        fuzz: async () => ({ disagreements: [] }),
        generate: async () => {
          generated++;
          return { source: okSource, promptHash: "p" };
        },
      }),
    SlimExit,
  );
  assert.equal(generated, 0);
});
