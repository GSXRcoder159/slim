import { createHash } from "node:crypto";
import type { SlimValue } from "../envelope/types.ts";

const REDACT_RE = /password|token|secret|authorization/i;
const MAX_STRING = 4096; /* ponytail: 4KiB cap */
const DEFAULT_BUDGET = 10_000;

export function serialize(value: unknown, opts?: { budget?: number }): SlimValue {
  const budget = { n: opts?.budget ?? DEFAULT_BUDGET };
  const seen = new Map<object, number>();
  const ids = { next: 0 };
  return walk(value, seen, ids, budget);
}

export function deserialize(v: SlimValue): unknown {
  const seen: unknown[] = [];
  return decode(v, seen);
}

export function snapshot(args: unknown[]): SlimValue[] {
  return args.map((a) => serialize(a));
}

export function mutatedArgIndexes(before: SlimValue[], after: SlimValue[]): number[] {
  const n = Math.max(before.length, after.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!slimEq(before[i], after[i])) out.push(i);
  }
  return out;
}

function walk(
  value: unknown,
  seen: Map<object, number>,
  ids: { next: number },
  budget: { n: number },
): SlimValue {
  if (budget.n <= 0) return { t: "undef" };
  budget.n--;

  if (value === undefined) return { t: "undef" };
  if (value === null) return { t: "null" };
  if (typeof value === "boolean") return { t: "bool", v: value };
  if (typeof value === "string") return serializeString(value);
  if (typeof value === "bigint") return { t: "bigint", v: value.toString() };
  if (typeof value === "symbol") return { t: "str", v: value.toString() };
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { t: "num", v: "NaN" };
    if (value === Infinity) return { t: "num", v: "Infinity" };
    if (value === -Infinity) return { t: "num", v: "-Infinity" };
    if (Object.is(value, -0)) return { t: "num", v: "-0" };
    return { t: "num", v: value };
  }

  if (typeof value === "function" || (typeof value === "object" && value !== null)) {
    const obj = value as object;
    const existing = seen.get(obj);
    if (existing !== undefined) return { t: "ref", id: existing };
    const id = ids.next++;
    seen.set(obj, id);
  } else {
    return { t: "undef" };
  }

  if (typeof value === "function") {
    return {
      t: "fn",
      ...(value.name ? { name: value.name } : {}),
      length: value.length,
    };
  }

  if (value instanceof Promise) return { t: "promise" };
  if (value instanceof Date) return { t: "date", v: value.getTime() };
  if (value instanceof RegExp) {
    return { t: "regexp", source: value.source, flags: value.flags };
  }
  if (value instanceof Error) {
    const err = value as Error & { code?: string | number };
    return {
      t: "err",
      name: err.name,
      message: err.message,
      ...(err.code !== undefined ? { code: err.code } : {}),
    };
  }
  if (value instanceof Uint8Array) {
    const out: SlimValue = { t: "bytes", kind: "u8", len: value.length };
    if (value.length <= 256) {
      out.b64 = Buffer.from(value).toString("base64");
    }
    return out;
  }
  if (value instanceof Map) {
    const entries: [SlimValue, SlimValue][] = [];
    for (const [k, val] of value.entries()) {
      const keySv = walk(k, seen, ids, budget);
      const valSv =
        typeof k === "string" && REDACT_RE.test(k)
          ? redacted()
          : walk(val, seen, ids, budget);
      entries.push([keySv, valSv]);
    }
    return { t: "map", v: entries };
  }
  if (value instanceof Set) {
    const items: SlimValue[] = [];
    for (const item of value) items.push(walk(item, seen, ids, budget));
    return { t: "set", v: items };
  }
  if (Array.isArray(value)) {
    const holes: number[] = [];
    const items: SlimValue[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        holes.push(i);
        items.push({ t: "undef" });
      } else {
        items.push(walk(value[i], seen, ids, budget));
      }
    }
    return { t: "arr", v: items, holes };
  }

  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec);
  const fields: Record<string, SlimValue> = {};
  for (const k of keys) {
    fields[k] = REDACT_RE.test(k) ? redacted() : walk(rec[k], seen, ids, budget);
  }
  return { t: "obj", keys, v: fields };
}

function serializeString(s: string): SlimValue {
  if (REDACT_RE.test(s)) return redacted();
  if (s.length > MAX_STRING) {
    /* ponytail: 4KiB cap */
    const hash = createHash("sha256").update(s).digest("hex");
    return { t: "str", v: s.slice(0, MAX_STRING) + "\nsha256:" + hash };
  }
  return { t: "str", v: s };
}

function redacted(): SlimValue {
  return { t: "str", v: "[redacted]", redacted: true };
}

function decode(v: SlimValue | undefined, seen: unknown[]): unknown {
  if (!v) return undefined;
  switch (v.t) {
    case "undef":
      return undefined;
    case "null":
      return null;
    case "bool":
      return v.v;
    case "num":
      if (v.v === "NaN") return NaN;
      if (v.v === "-0") return -0;
      if (v.v === "Infinity") return Infinity;
      if (v.v === "-Infinity") return -Infinity;
      return v.v;
    case "str":
      return v.v;
    case "bigint":
      return BigInt(v.v);
    case "date": {
      const d = new Date(v.v);
      seen.push(d);
      return d;
    }
    case "err": {
      const e = new Error(v.message);
      e.name = v.name;
      if (v.code !== undefined) (e as Error & { code?: string | number }).code = v.code;
      seen.push(e);
      return e;
    }
    case "fn": {
      const f = function noop() {};
      try {
        Object.defineProperty(f, "name", { value: v.name ?? "", configurable: true });
        Object.defineProperty(f, "length", { value: v.length ?? 0, configurable: true });
      } catch {
        /* ignore */
      }
      seen.push(f);
      return f;
    }
    case "arr": {
      const a: unknown[] = [];
      seen.push(a);
      for (let i = 0; i < v.v.length; i++) {
        if (v.holes.includes(i)) continue;
        a[i] = decode(v.v[i], seen);
      }
      return a;
    }
    case "obj": {
      const o: Record<string, unknown> = {};
      seen.push(o);
      for (const k of v.keys) o[k] = decode(v.v[k], seen);
      return o;
    }
    case "map": {
      const m = new Map<unknown, unknown>();
      seen.push(m);
      for (const [k, val] of v.v) m.set(decode(k, seen), decode(val, seen));
      return m;
    }
    case "set": {
      const s = new Set<unknown>();
      seen.push(s);
      for (const item of v.v) s.add(decode(item, seen));
      return s;
    }
    case "ref":
      return seen[v.id];
    case "promise": {
      const p = Promise.resolve();
      seen.push(p);
      return p;
    }
    case "regexp": {
      const r = new RegExp(v.source, v.flags);
      seen.push(r);
      return r;
    }
    case "bytes": {
      const u8 = v.b64
        ? Uint8Array.from(Buffer.from(v.b64, "base64"))
        : new Uint8Array(v.len ?? 0);
      seen.push(u8);
      return u8;
    }
    default:
      return undefined;
  }
}

function slimEq(a: SlimValue | undefined, b: SlimValue | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if (a.t !== b.t) return false;
  switch (a.t) {
    case "undef":
    case "null":
    case "promise":
      return true;
    case "bool":
    case "num":
    case "str":
    case "bigint":
    case "date":
      return (a as { v: unknown }).v === (b as { v: unknown }).v &&
        (a.t !== "str" || a.redacted === (b as typeof a).redacted);
    case "err":
      return (
        b.t === "err" &&
        a.name === b.name &&
        a.message === b.message &&
        a.code === b.code
      );
    case "fn":
      return b.t === "fn" && a.name === b.name && a.length === b.length;
    case "arr":
      return (
        b.t === "arr" &&
        a.holes.length === b.holes.length &&
        a.holes.every((h, i) => h === b.holes[i]) &&
        a.v.length === b.v.length &&
        a.v.every((x, i) => slimEq(x, b.v[i]))
      );
    case "obj":
      return (
        b.t === "obj" &&
        a.keys.length === b.keys.length &&
        a.keys.every((k, i) => k === b.keys[i] && slimEq(a.v[k], b.v[k]))
      );
    case "map":
      return (
        b.t === "map" &&
        a.v.length === b.v.length &&
        a.v.every(
          (pair, i) =>
            slimEq(pair[0], b.v[i]?.[0]) && slimEq(pair[1], b.v[i]?.[1]),
        )
      );
    case "set":
      return (
        b.t === "set" &&
        a.v.length === b.v.length &&
        a.v.every((x, i) => slimEq(x, b.v[i]))
      );
    case "bytes":
      return b.t === "bytes" && a.kind === b.kind && a.len === b.len && a.b64 === b.b64;
    case "ref":
      return b.t === "ref" && a.id === b.id;
    case "regexp":
      return b.t === "regexp" && a.source === b.source && a.flags === b.flags;
    default:
      return false;
  }
}
