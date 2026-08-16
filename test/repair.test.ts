import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repairLoop } from "../src/generate/repair.ts";
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
    publicApi: "export function ms(x: unknown): number;",
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
    publicApi: "",
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
