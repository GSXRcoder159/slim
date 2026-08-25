import type { ArgShape, SlimValue, TraceEvent } from "../envelope/types.ts";
import { deserialize, deserializeEvent } from "../trace/serialize.ts";
import { clone } from "./clone.ts";

export interface Gen {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(xs: T[]): T;
  bool(): boolean;
}

/** mulberry32 — deterministic, 32-bit. */
export function createGen(seed: number): Gen {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min: number, max: number): number {
      if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
      if (max < min) {
        const tmp = min;
        min = max;
        max = tmp;
      }
      const span = max - min + 1;
      return min + Math.floor(next() * span);
    },
    pick<T>(xs: T[]): T {
      if (xs.length === 0) throw new Error("Gen.pick: empty array");
      return xs[this.int(0, xs.length - 1)] as T;
    },
    bool(): boolean {
      return next() < 0.5;
    },
  };
}

export function fromTraces(traces: TraceEvent[], _gen: Gen): unknown[][] {
  return traces.map((tr) => deserializeEvent({ args: tr.args, thisArg: tr.thisArg, result: tr.result }).args);
}

export function mutateArgs(args: unknown[], gen: Gen): unknown[] {
  const out = clone(args) as unknown[];
  const kind = gen.int(0, 9);
  switch (kind) {
    case 0: {
      const obj = firstObject(out);
      if (obj) obj[`extra_${gen.int(0, 99)}`] = gen.pick([1, "x", true, null]);
      else out.push({ extra: true });
      break;
    }
    case 1: {
      const obj = firstObject(out);
      if (obj) {
        const keys = Object.keys(obj);
        if (keys.length) delete obj[gen.pick(keys)];
      }
      break;
    }
    case 2: {
      const i = indexOfType(out, "string");
      if (i >= 0) out[i] = `${out[i]}\u2603\u0301`;
      else out.push("unicodé\u0000");
      break;
    }
    case 3:
      out[gen.int(0, Math.max(0, out.length - 1))] = -0;
      break;
    case 4:
      out[gen.int(0, Math.max(0, out.length - 1))] = NaN;
      break;
    case 5: {
      const sparse = new Array(gen.int(2, 6));
      sparse[sparse.length - 1] = 1;
      if (out.length) out[0] = sparse;
      else out.push(sparse);
      break;
    }
    case 6:
      if (out.length) out[gen.int(0, out.length - 1)] = null;
      else out.push(null);
      break;
    case 7:
      if (out.length) out[gen.int(0, out.length - 1)] = undefined;
      else out.push(undefined);
      break;
    case 8: {
      const obj = firstObject(out) ?? Object.create(null);
      Object.defineProperty(obj, "__proto__", {
        value: { polluted: true },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      if (!firstObject(out)) out.push(obj);
      break;
    }
    case 9:
    default: {
      if (gen.bool() && out.length) out.pop();
      else out.push(junkValue(gen));
      break;
    }
  }
  return out;
}

export function fromShapes(shapes: ArgShape[], gen: Gen, argc = shapes.length): unknown[] {
  const n = Math.max(0, argc);
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const s = shapes[i];
    out.push(s ? fromShape(s, gen, 0) : junkValue(gen));
  }
  return out;
}

/** Result-member / returned-function traces are not top-level export calls. */
export function isExportTrace(tr: TraceEvent): boolean {
  return tr.parentOriginId === undefined && tr.resultMember === undefined;
}

export function pickObservedArgc(observed: number[], gen: Gen, fallback = 2): number {
  if (!observed.length) return fallback;
  return gen.pick(observed);
}

export function junkArgs(argc: number, gen: Gen): unknown[] {
  const n = Math.max(0, argc);
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) out.push(junkValue(gen));
  return out;
}

export function enumerateLiteralUnions(shapes: ArgShape[], cap: number): unknown[][] {
  if (!shapes.length) return [];
  if (!shapes.every((s) => (s.kind === "literal" || s.kind === "union") && s.literals && s.literals.length)) {
    return [];
  }
  const domains: unknown[][] = shapes.map((s) => s.literals ?? []);
  const combos = cartesian(domains, cap);
  return combos;
}

function fromShape(shape: ArgShape, gen: Gen, depth: number): unknown {
  if (depth > 6) return null;
  switch (shape.kind) {
    case "literal":
    case "union":
      if (shape.literals && shape.literals.length) return gen.pick(shape.literals);
      return junkValue(gen);
    case "object": {
      const o: Record<string, unknown> = {};
      if (shape.props) {
        for (const [k, v] of Object.entries(shape.props)) {
          o[k] = fromShape(v, gen, depth + 1);
        }
      }
      return o;
    }
    case "array": {
      if (shape.elements && shape.elements.length) {
        return shape.elements.map((el) => fromShape(el, gen, depth + 1));
      }
      const n = gen.int(0, 3);
      const inner: ArgShape = shape.props
        ? { kind: "object", props: shape.props }
        : { kind: "any" };
      const a: unknown[] = [];
      for (let i = 0; i < n; i++) a.push(fromShape(inner, gen, depth + 1));
      return a;
    }
    case "function": {
      const arity = shape.fnArity ?? 0;
      const fn = function slimFuzzFn() {
        return undefined;
      };
      Object.defineProperty(fn, "length", { value: arity });
      return fn;
    }
    case "date":
      return new Date(gen.int(0, 1_600_000_000_000));
    case "any":
    case "unknown":
    default:
      return junkValue(gen);
  }
}

export function hydrate(value: SlimValue, _refs?: Map<number, unknown>): unknown {
  return deserialize(value);
}

function junkValue(gen: Gen): unknown {
  const pick = gen.int(0, 12);
  switch (pick) {
    case 0:
      return null;
    case 1:
      return undefined;
    case 2:
      return NaN;
    case 3:
      return -0;
    case 4:
      return 0;
    case 5:
      return "";
    case 6:
      return "x";
    case 7:
      return true;
    case 8:
      return false;
    case 9:
      return {};
    case 10:
      return [];
    case 11:
      return () => undefined;
    default:
      return gen.int(-10, 10);
  }
}

function firstObject(args: unknown[]): Record<string, unknown> | null {
  for (const a of args) {
    if (a !== null && typeof a === "object" && !Array.isArray(a) && !(a instanceof Date)) {
      return a as Record<string, unknown>;
    }
  }
  return null;
}

function indexOfType(args: unknown[], t: string): number {
  return args.findIndex((a) => typeof a === t);
}

function cartesian(domains: unknown[][], cap: number): unknown[][] {
  let acc: unknown[][] = [[]];
  for (const d of domains) {
    const next: unknown[][] = [];
    for (const prefix of acc) {
      for (const v of d) {
        next.push([...prefix, v]);
        if (next.length >= cap) return next;
      }
    }
    acc = next;
    if (acc.length >= cap) return acc.slice(0, cap);
  }
  return acc.slice(0, cap);
}
