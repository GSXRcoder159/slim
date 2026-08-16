import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ArgShape, Envelope, TraceEvent } from "../envelope/types.ts";

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
  const body = standingFile(opts.runner, opts.moduleSpecifier, pairs, opts.env);
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

function standingFile(
  runner: "node:test" | "vitest",
  mod: string,
  traces: TraceEvent[],
  env: Envelope,
): string {
  const imports =
    runner === "vitest"
      ? `import { test, expect } from "vitest";
import * as slim from ${JSON.stringify(mod)};
`
      : `import { test } from "node:test";
import assert from "node:assert/strict";
import * as slim from ${JSON.stringify(mod)};
`;
  const eq =
    runner === "vitest"
      ? `function eq(actual: unknown, expected: unknown): void {
  expect(actual).toEqual(expected);
}
function eqThrows(fn: () => unknown, name: string, message: string): void {
  expect(fn).toThrow();
  try { fn(); } catch (err) {
    const e = err as Error;
    expect(e.name).toEqual(name);
    expect(e.message).toEqual(message);
  }
}
`
      : `function eq(actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected);
}
function eqThrows(fn: () => unknown, name: string, message: string): void {
  assert.throws(fn, (err: Error) => {
    assert.equal(err.name, name);
    assert.equal(err.message, message);
    return true;
  });
}
`;
  return `${imports}
// Frozen I/O pairs. This file must not import the original package.
const pairs = ${JSON.stringify(traces.map(compactTrace), null, 2)};

${eq}
test("slim ${env.package.name} frozen pairs", () => {
  for (const p of pairs) {
    const fn = (slim as Record<string, unknown>)[p.symbol];
    if (typeof fn !== "function") continue;
    const args = p.args.map(revive);
    if (p.threw) {
      eqThrows(() => (fn as Function).apply(undefined, args), p.threw.name, p.threw.message);
    } else {
      const got = (fn as Function).apply(undefined, args);
      eq(got, revive(p.result));
    }
  }
});
${debounceBlock(env)}
${FAKE_CLOCK}
function revive(v: any): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v !== "object") return v;
  if (v.t === "undef") return undefined;
  if (v.t === "null") return null;
  if (v.t === "bool" || v.t === "str" || v.t === "bigint") return v.v;
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
  if (v.t === "date") return new Date(v.v);
  if (v.t === "regexp") return new RegExp(v.source, v.flags);
  if (v.t === "map") return new Map((v.v as [unknown, unknown][]).map(([k, val]) => [revive(k), revive(val)]));
  if (v.t === "set") return new Set((v.v as unknown[]).map(revive));
  return v.v;
}
`;
}

function compactTrace(t: TraceEvent) {
  return { symbol: t.symbol, args: t.args, threw: t.threw ?? null, result: t.result ?? null };
}

function debounceBlock(env: Envelope): string {
  const timer = env.symbols.find((s) => s.exportName === "debounce" || s.exportName === "throttle");
  if (!timer) return "";
  const name = timer.exportName;
  const scripts = ["trailing-single", "cancel-mid"];
  if (observedOptions(timer.callSites)) {
    scripts.push("leading-only");
  }
  const bodies: Record<string, string> = {
    "trailing-single": `
test("debounce trailing-single", () => {
  const clock = createStandingClock();
  try {
    const ${name} = (slim as { ${name}: Function }).${name};
    let n = 0;
    let last: unknown;
    const d = ${name}((x: unknown) => { n++; last = x; }, 32);
    d("a");
    clock.advance(32);
    eq(n, 1);
    eq(last, "a");
  } finally {
    clock.restore();
  }
});
`,
    "cancel-mid": `
test("debounce cancel-mid", () => {
  const clock = createStandingClock();
  try {
    const ${name} = (slim as { ${name}: Function }).${name};
    let n = 0;
    const d = ${name}(() => { n++; }, 32);
    d("nope");
    clock.advance(10);
    d.cancel();
    clock.advance(32);
    eq(n, 0);
  } finally {
    clock.restore();
  }
});
`,
    "leading-only": `
test("debounce leading-only", () => {
  const clock = createStandingClock();
  try {
    const ${name} = (slim as { ${name}: Function }).${name};
    let n = 0;
    let last: unknown;
    const d = ${name}((x: unknown) => { n++; last = x; }, 32, { leading: true, trailing: false });
    d("L");
    clock.advance(10);
    d("ignored");
    clock.advance(32);
    eq(n, 1);
    eq(last, "L");
  } finally {
    clock.restore();
  }
});
`,
  };
  return scripts.map((s) => bodies[s] ?? "").join("");
}

function observedOptions(
  callSites: Envelope["symbols"][number]["callSites"],
): boolean {
  for (const c of callSites) {
    if ((c.argc.max ?? 0) >= 3 || c.argc.observed.some((n) => n >= 3)) return true;
    const opts = c.argShapes[2];
    if (opts && shapeHasOptions(opts)) return true;
  }
  return false;
}

function shapeHasOptions(shape: ArgShape): boolean {
  if (shape.kind === "object") return true;
  if (shape.kind === "literal" && shape.literals?.some((v) => v && typeof v === "object")) return true;
  return false;
}

const FAKE_CLOCK = `
function createStandingClock(): {
  advance(ms: number): void;
  restore(): void;
} {
  let time = 0;
  let nextId = 1;
  const timers = new Map<number, { cb: () => void; when: number }>();
  const savedNow = Date.now;
  const savedSet = globalThis.setTimeout;
  const savedClear = globalThis.clearTimeout;
  Date.now = () => time;
  globalThis.setTimeout = ((cb: () => void, ms?: number) => {
    const id = nextId++;
    timers.set(id, { cb, when: time + (Number(ms) || 0) });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    timers.delete(id as unknown as number);
  }) as typeof clearTimeout;
  return {
    advance(ms: number) {
      time += ms;
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const [id, timer] of [...timers]) {
          if (timer.when <= time) {
            timers.delete(id);
            timer.cb();
            progressed = true;
          }
        }
      }
    },
    restore() {
      Date.now = savedNow;
      globalThis.setTimeout = savedSet;
      globalThis.clearTimeout = savedClear;
      timers.clear();
    },
  };
}
`;
