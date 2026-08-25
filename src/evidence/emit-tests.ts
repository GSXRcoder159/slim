import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ArgShape, Envelope, SlimValue, TraceEvent } from "../envelope/types.ts";
import { emptyHyrum } from "../envelope/types.ts";
import { STANDING_RUNTIME } from "./standing-equal.ts";

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
  const wanted = standingSymbols(opts.env);
  const pairs = opts.traces.filter(
    (t) =>
      t.symbol &&
      wanted.has(t.symbol) &&
      !/[.(]/.test(t.symbol) &&
      standingPairReplayable(t, opts.env),
  );
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
      ? `import { test } from "vitest";
import * as slim from ${JSON.stringify(mod)};
`
      : `import { test } from "node:test";
import * as slim from ${JSON.stringify(mod)};
`;
  const hyrumBySymbol = Object.fromEntries(
    env.symbols.map((s) => [s.exportName, s.hyrum ?? emptyHyrum()]),
  );
  return `${imports}
// Frozen I/O pairs. This file must not import the original package.
const pairs = ${JSON.stringify(traces.map((t) => compactTrace(t, hyrumBySymbol[t.symbol] ?? emptyHyrum())), null, 2)};

${STANDING_RUNTIME}
test("slim ${env.package.name} frozen pairs", () => {
  for (const p of pairs) {
    const fn = (slim as Record<string, unknown>)[p.symbol];
    if (typeof fn !== "function") continue;
    checkFrozenPair(fn as Function, p);
  }
});
${debounceBlock(env)}
${FAKE_CLOCK}
`.replace(/\n+$/, "\n");
}

function compactTrace(t: TraceEvent, hyrum: ReturnType<typeof emptyHyrum>) {
  return {
    symbol: t.symbol,
    args: t.args,
    thisArg: t.thisArg ?? null,
    threw: t.threw ?? null,
    result: t.result ?? null,
    hyrum,
    ...(t.argsAfter && !t.argsAfter.some((a) => slimValueHasFn(a)) ? { argsAfter: t.argsAfter } : {}),
    ...(t.thisAfter && !slimValueHasFn(t.thisAfter) ? { thisAfter: t.thisAfter } : {}),
  };
}

function standingSymbols(env: Envelope): Set<string> {
  const out = new Set<string>();
  for (const s of env.symbols) {
    if (!s.exportName || s.exportName === "*" || s.exportName === "(scan)") continue;
    out.add(s.exportName);
    if (s.exportName === "head") out.add("first");
    if (s.exportName === "first") out.add("head");
  }
  return out;
}

/** Drop successful traces whose args/result contain functions; revive cannot reconstruct them. */
function standingPairReplayable(t: TraceEvent, env: Envelope): boolean {
  if (t.threw) return true;
  if (t.args.some(slimValueHasFn)) return false;
  if (t.result && slimValueHasFn(t.result)) return false;
  if (t.result && slimValueNotReviveable(t.result)) return false;
  if (env.cryptoRandom && !hasInjectableRandomArg(t)) return false;
  return true;
}

/** URL / Promise / host objects serialize as empty proto:other objects that revive cannot rebuild. */
function slimValueNotReviveable(v: SlimValue, depth = 0): boolean {
  if (depth > 24) return false;
  if (v.t === "promise") return true;
  if (v.t === "obj" && v.proto === "other" && (v.keys ?? []).length === 0) return true;
  if (v.t === "arr") return v.v.some((el) => slimValueNotReviveable(el, depth + 1));
  if (v.t === "obj") {
    if (Object.values(v.v).some((el) => slimValueNotReviveable(el, depth + 1))) return true;
    return (v.syms ?? []).some((s) => slimValueNotReviveable(s.v, depth + 1));
  }
  if (v.t === "map") {
    return v.v.some(([k, val]) => slimValueNotReviveable(k, depth + 1) || slimValueNotReviveable(val, depth + 1));
  }
  if (v.t === "set") return v.v.some((item) => slimValueNotReviveable(item, depth + 1));
  return false;
}

/** uuid v4({ random }) is replayable; bare nanoid()/v4() is not without a seeded CSPRNG. */
function hasInjectableRandomArg(t: TraceEvent): boolean {
  for (const a of t.args) {
    if (a.t !== "obj") continue;
    const random = a.v?.random;
    if (random && random.t === "bytes" && (random.b64 || (random.len ?? 0) >= 16)) return true;
  }
  return false;
}

function slimValueHasFn(v: SlimValue | undefined, depth = 0): boolean {
  /* ponytail: depth 24; nested SlimValues beyond that are treated as non-fn. */
  if (!v || depth > 24) return false;
  if (v.t === "fn") return true;
  if (v.t === "arr") return v.v.some((el) => slimValueHasFn(el, depth + 1));
  if (v.t === "obj") {
    if (Object.values(v.v).some((el) => slimValueHasFn(el, depth + 1))) return true;
    return (v.syms ?? []).some((s) => slimValueHasFn(s.v, depth + 1));
  }
  if (v.t === "map") {
    return v.v.some(([k, val]) => slimValueHasFn(k, depth + 1) || slimValueHasFn(val, depth + 1));
  }
  if (v.t === "set") return v.v.some((el) => slimValueHasFn(el, depth + 1));
  return false;
}

function debounceBlock(env: Envelope): string {
  const timer = env.symbols.find((s) => s.exportName === "debounce" || s.exportName === "throttle");
  if (!timer) return "";
  const name = timer.exportName;
  const scripts = ["trailing-single", "cancel-mid", "flush-mid", "flush-empty"];
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
    "flush-mid": `
test("debounce flush-mid", () => {
  const clock = createStandingClock();
  try {
    const ${name} = (slim as { ${name}: Function }).${name};
    let n = 0;
    let last: unknown;
    const d = ${name}((x: unknown) => { n++; last = x; }, 32);
    d("flush-me");
    clock.advance(10);
    d.flush();
    eq(n, 1);
    eq(last, "flush-me");
    clock.advance(32);
    eq(n, 1);
  } finally {
    clock.restore();
  }
});
`,
    "flush-empty": `
test("debounce flush-empty", () => {
  const clock = createStandingClock();
  try {
    const ${name} = (slim as { ${name}: Function }).${name};
    let n = 0;
    const d = ${name}(() => { n++; }, 32);
    const flushed = d.flush();
    eq(n, 0);
    eq(flushed, undefined);
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
