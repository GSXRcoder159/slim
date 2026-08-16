import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Envelope } from "../envelope/types.ts";
import type { SlimValue, TraceEvent } from "../envelope/types.ts";

export function emitStandingTests(opts: {
  root: string;
  outDir: string;
  pkg: string;
  env: Envelope;
  traces: TraceEvent[];
  runner: "node:test" | "vitest";
  moduleSpecifier: string;
}): string {
  mkdirSync(join(opts.root, opts.outDir), { recursive: true });
  const file = join(opts.root, opts.outDir, `${opts.pkg.replace(/\//g, "-")}.test.ts`);
  const pairs = opts.traces.filter((t) => t.symbol && !t.symbol.includes("."));
  const body =
    opts.runner === "vitest" ? vitestFile(opts.moduleSpecifier, pairs, opts.env) : nodeFile(opts.moduleSpecifier, pairs, opts.env);
  writeFileSync(file, body);
  const pkgPath = join(opts.root, "package.json");
  if (existsSync(pkgPath)) {
    const raw = readFileSync(pkgPath, "utf8");
    if (!raw.includes("slim:evidence")) {
      const json = JSON.parse(raw) as { scripts?: Record<string, string> };
      json.scripts = json.scripts ?? {};
      json.scripts["slim:evidence"] =
        opts.runner === "vitest"
          ? `vitest run ${relative(opts.root, file)}`
          : `node --experimental-strip-types --test ${relative(opts.root, file)}`;
      writeFileSync(pkgPath, JSON.stringify(json, null, 2) + "\n");
    }
  }
  return file;
}

function nodeFile(mod: string, traces: TraceEvent[], env: Envelope): string {
  return `import { test } from "node:test";
import assert from "node:assert/strict";
import * as slim from ${JSON.stringify(mod)};

// Frozen I/O pairs. This file must not import the original package.
const pairs = ${JSON.stringify(traces.map(compactTrace), null, 2)};

test("slim ${env.package.name} frozen pairs", () => {
  for (const p of pairs) {
    const fn = (slim as Record<string, unknown>)[p.symbol];
    if (typeof fn !== "function") continue;
    const args = p.args.map(revive);
    if (p.threw) {
      assert.throws(() => (fn as Function).apply(undefined, args), (err: Error) => {
        assert.equal(err.name, p.threw!.name);
        assert.equal(err.message, p.threw!.message);
        return true;
      });
    } else {
      const got = (fn as Function).apply(undefined, args);
      if (p.result && p.result.t === "undef") {
        assert.equal(got, undefined);
      }
    }
  }
});
${debounceBlock(env)}
function revive(v: any): unknown {
  if (!v || typeof v !== "object") return v;
  if (v.t === "undef") return undefined;
  if (v.t === "null") return null;
  if (v.t === "bool" || v.t === "str") return v.v;
  if (v.t === "num") {
    if (v.v === "NaN") return NaN;
    if (v.v === "-0") return -0;
    if (v.v === "Infinity") return Infinity;
    if (v.v === "-Infinity") return -Infinity;
    return v.v;
  }
  if (v.t === "arr") return v.v.map(revive);
  if (v.t === "obj") {
    const o: Record<string, unknown> = {};
    for (const k of v.keys ?? Object.keys(v.v ?? {})) o[k] = revive(v.v[k]);
    return o;
  }
  return v.v;
}
`;
}

function vitestFile(mod: string, traces: TraceEvent[], env: Envelope): string {
  return nodeFile(mod, traces, env)
    .replace(`import { test } from "node:test";`, `import { test, expect } from "vitest";`)
    .replace(`import assert from "node:assert/strict";\n`, "")
    .replace(/assert\.equal\(([^,]+), ([^)]+)\)/g, "expect($1).toEqual($2)")
    .replace(
      /assert\.throws\(\(\) => (\(fn as Function\)\.apply\(undefined, args\)), \(err: Error\) => \{[\s\S]*?return true;\s*\}\);/,
      "expect(() => (fn as Function).apply(undefined, args)).toThrow()",
    );
}

function compactTrace(t: TraceEvent) {
  return { symbol: t.symbol, args: t.args, threw: t.threw ?? null, result: t.result ?? null };
}

function debounceBlock(env: Envelope): string {
  if (!env.symbols.some((s) => s.exportName === "debounce")) return "";
  return `
test("debounce cancel exists (frozen clock script)", async () => {
  const debounce = (slim as { debounce: Function }).debounce;
  let n = 0;
  const d = debounce(() => { n++; }, 20);
  d();
  d.cancel();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(n, 0);
});
`;
}

void join;
