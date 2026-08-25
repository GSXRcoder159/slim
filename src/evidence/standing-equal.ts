export { equal, equalResults, invoke } from "../fuzz/equal.ts";
export { deserializeEvent } from "../trace/serialize.ts";

/** Self-contained standing-test helpers. Must stay aligned with equal() / deserializeEvent. */
export const STANDING_RUNTIME = `
function decode(v, seen) {
  if (!v) return undefined;
  switch (v.t) {
    case "undef":
    case "trunc":
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
      if (v.code !== undefined) e.code = v.code;
      seen.push(e);
      return e;
    }
    case "fn": {
      const f = function noop() {};
      try {
        Object.defineProperty(f, "name", { value: v.name ?? "", configurable: true });
        Object.defineProperty(f, "length", { value: v.length ?? 0, configurable: true });
      } catch { /* ignore */ }
      seen.push(f);
      return f;
    }
    case "arr": {
      const a = new Array(v.v.length);
      seen.push(a);
      for (let i = 0; i < v.v.length; i++) {
        if ((v.holes ?? []).includes(i)) continue;
        a[i] = decode(v.v[i], seen);
      }
      return a;
    }
    case "obj": {
      const o = Object.create(null);
      seen.push(o);
      for (const k of v.keys ?? []) {
        Object.defineProperty(o, k, {
          value: decode(v.v[k], seen),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      for (const s of v.syms ?? []) {
        const sym = s.g ? Symbol.for(s.k) : Symbol(s.k);
        Object.defineProperty(o, sym, {
          value: decode(s.v, seen),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return o;
    }
    case "map": {
      const m = new Map();
      seen.push(m);
      for (const [k, val] of v.v) m.set(decode(k, seen), decode(val, seen));
      return m;
    }
    case "set": {
      const s = new Set();
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

function reviveEvent(p) {
  const seen = [];
  const args = (p.args ?? []).map((a) => decode(a, seen));
  const thisArg = p.thisArg == null ? undefined : decode(p.thisArg, seen);
  const result = p.result == null ? undefined : decode(p.result, seen);
  return { args, thisArg, result };
}

function collectObjs(v, bag) {
  if (v === null || (typeof v !== "object" && typeof v !== "function")) return;
  if (bag.has(v)) return;
  bag.add(v);
  if (v instanceof Date || v instanceof RegExp || v instanceof Error) return;
  if (Array.isArray(v)) {
    for (const el of v) collectObjs(el, bag);
    return;
  }
  if (v instanceof Map) {
    for (const [k, val] of v) {
      collectObjs(k, bag);
      collectObjs(val, bag);
    }
    return;
  }
  if (v instanceof Set) {
    for (const el of v) collectObjs(el, bag);
    return;
  }
  for (const k of Reflect.ownKeys(v)) collectObjs(v[k], bag);
}

function aliasedFromInputs(result, args, thisArg) {
  if (result === null || (typeof result !== "object" && typeof result !== "function")) return false;
  const bag = new Set();
  for (const a of args) collectObjs(a, bag);
  collectObjs(thisArg, bag);
  return bag.has(result);
}

function enumerableOwn(obj, key) {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return d?.enumerable === true;
}

function sameValueZero(a, b, signedZero) {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    if (signedZero) return Object.is(a, b);
    return a === b;
  }
  return a === b;
}

function eqDeep(a, b, ctx, seen) {
  if (sameValueZero(a, b, ctx.signedZero)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a === "function" && typeof b === "function") {
    return a === b || (a.name === b.name && a.length === b.length);
  }
  if (typeof a !== "object" || typeof b !== "object") return false;
  const prev = seen.get(a);
  if (prev) return prev === b;
  seen.set(a, b);
  if (ctx.prototype && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Date && b instanceof Date) {
    const at = a.getTime();
    const bt = b.getTime();
    if (Number.isNaN(at) && Number.isNaN(bt)) return true;
    return at === bt;
  }
  if (a instanceof Date || b instanceof Date) return false;
  if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    const ae = [...a.entries()];
    const be = [...b.entries()];
    if (ctx.keyOrder) {
      for (let i = 0; i < ae.length; i++) {
        if (!eqDeep(ae[i][0], be[i][0], ctx, seen) || !eqDeep(ae[i][1], be[i][1], ctx, seen)) return false;
      }
      return true;
    }
    const unused = be.slice();
    for (const [ak, av] of ae) {
      const idx = unused.findIndex(([bk, bv]) => eqDeep(ak, bk, ctx, new WeakMap()) && eqDeep(av, bv, ctx, new WeakMap()));
      if (idx < 0) return false;
      unused.splice(idx, 1);
    }
    return true;
  }
  if (a instanceof Map || b instanceof Map) return false;
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    if (ctx.keyOrder) {
      const aa = [...a];
      const bb = [...b];
      for (let i = 0; i < aa.length; i++) if (!eqDeep(aa[i], bb[i], ctx, seen)) return false;
      return true;
    }
    const unused = [...b];
    for (const av of a) {
      const idx = unused.findIndex((bv) => eqDeep(av, bv, ctx, new WeakMap()));
      if (idx < 0) return false;
      unused.splice(idx, 1);
    }
    return true;
  }
  if (a instanceof Set || b instanceof Set) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if ((i in a) !== (i in b)) return false;
      if ((i in a) && !eqDeep(a[i], b[i], ctx, seen)) return false;
    }
    return true;
  }
  if (a instanceof Error && b instanceof Error) {
    return a.name === b.name && a.message === b.message && Object.is(a.code, b.code);
  }
  const aKeys = Reflect.ownKeys(a).filter((k) => enumerableOwn(a, k));
  const bKeys = Reflect.ownKeys(b).filter((k) => enumerableOwn(b, k));
  if (aKeys.length !== bKeys.length) return false;
  if (ctx.keyOrder) {
    for (let i = 0; i < aKeys.length; i++) if (aKeys[i] !== bKeys[i]) return false;
  } else {
    const bSet = new Set(bKeys);
    for (const k of aKeys) if (!bSet.has(k)) return false;
  }
  for (const k of aKeys) {
    if (!eqDeep(a[k], b[k], ctx, seen)) return false;
  }
  return true;
}

function extras(a, b, ctx) {
  if (ctx.toString) {
    try { if (String(a) !== String(b)) return false; } catch { return false; }
  }
  if (ctx.json) {
    let sa, sb;
    try { sa = JSON.stringify(a); } catch { sa = undefined; }
    try { sb = JSON.stringify(b); } catch { sb = undefined; }
    if (sa !== sb) return false;
  }
  return true;
}

function standingEqual(a, b, hyrum) {
  const ctx = {
    signedZero: hyrum?.signedZero === true,
    keyOrder: hyrum?.keyOrder === true,
    prototype: hyrum?.prototype === true,
    toString: hyrum?.toString === true,
    json: hyrum?.json === true,
    nan: hyrum?.nan === true,
    sparseArray: hyrum?.sparseArray === true,
    dateIdentity: hyrum?.dateIdentity === true,
    sameReference: hyrum?.sameReference === true,
    mutation: hyrum?.mutation === true,
    errorMessage: hyrum?.errorMessage === true,
  };
  if (!eqDeep(a, b, ctx, new WeakMap())) return false;
  return extras(a, b, ctx);
}

function eq(actual, expected, hyrum) {
  if (!standingEqual(actual, expected, hyrum)) {
    throw new Error("standing mismatch");
  }
}

function checkFrozenPair(fn, p) {
  const live = reviveEvent(p);
  const hyrum = p.hyrum ?? {};
  if (p.threw) {
    let threw = false;
    try {
      fn.apply(live.thisArg, live.args);
    } catch (err) {
      threw = true;
      const got = err instanceof Error
        ? { name: err.name, message: err.message, code: err.code }
        : { name: "Error", message: String(err) };
      if (got.name !== p.threw.name || got.message !== p.threw.message) {
        throw new Error("error mismatch: " + got.name + ":" + got.message);
      }
      if (p.threw.code !== undefined && !Object.is(got.code, p.threw.code)) {
        throw new Error("error code mismatch");
      }
    }
    if (!threw) throw new Error("expected throw " + p.threw.name);
    return;
  }
  const got = fn.apply(live.thisArg, live.args);
  const identity = hyrum.sameReference === true || hyrum.dateIdentity === true;
  if (identity && aliasedFromInputs(live.result, live.args, live.thisArg) && got !== live.result) {
    throw new Error("standing identity mismatch for " + p.symbol);
  }
  if (!standingEqual(got, live.result, hyrum)) {
    throw new Error("standing mismatch for " + p.symbol);
  }
}
`;
