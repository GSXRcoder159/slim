import { test } from "node:test";
import * as slim from "./lodash.ts";

// Frozen I/O pairs. This file must not import the original package.
const pairs = [
  {
    "symbol": "get",
    "args": [
      {
        "t": "obj",
        "keys": [
          "profile"
        ],
        "v": {
          "profile": {
            "t": "obj",
            "keys": [
              "name"
            ],
            "v": {
              "name": {
                "t": "str",
                "v": "Ada"
              }
            }
          }
        }
      },
      {
        "t": "str",
        "v": "profile.name"
      },
      {
        "t": "str",
        "v": "anonymous"
      }
    ],
    "thisArg": {
      "t": "fn",
      "name": "lodash",
      "length": 1
    },
    "threw": null,
    "result": {
      "t": "str",
      "v": "Ada"
    },
    "hyrum": {
      "errorMessage": false,
      "toString": false,
      "json": false,
      "nan": false,
      "sparseArray": true,
      "keyOrder": false,
      "prototype": true,
      "mutation": false,
      "dateIdentity": false,
      "sameReference": true,
      "signedZero": false
    }
  },
  {
    "symbol": "get",
    "args": [
      {
        "t": "obj",
        "keys": [],
        "v": {}
      },
      {
        "t": "str",
        "v": "profile.name"
      },
      {
        "t": "str",
        "v": "anonymous"
      }
    ],
    "thisArg": {
      "t": "fn",
      "name": "lodash",
      "length": 1
    },
    "threw": null,
    "result": {
      "t": "str",
      "v": "anonymous"
    },
    "hyrum": {
      "errorMessage": false,
      "toString": false,
      "json": false,
      "nan": false,
      "sparseArray": true,
      "keyOrder": false,
      "prototype": true,
      "mutation": false,
      "dateIdentity": false,
      "sameReference": true,
      "signedZero": false
    }
  },
  {
    "symbol": "get",
    "args": [
      {
        "t": "obj",
        "keys": [
          "profile"
        ],
        "v": {
          "profile": {
            "t": "obj",
            "keys": [
              "name"
            ],
            "v": {
              "name": {
                "t": "undef"
              }
            }
          }
        }
      },
      {
        "t": "str",
        "v": "profile.name"
      },
      {
        "t": "str",
        "v": "anonymous"
      }
    ],
    "thisArg": {
      "t": "fn",
      "name": "lodash",
      "length": 1
    },
    "threw": null,
    "result": {
      "t": "str",
      "v": "anonymous"
    },
    "hyrum": {
      "errorMessage": false,
      "toString": false,
      "json": false,
      "nan": false,
      "sparseArray": true,
      "keyOrder": false,
      "prototype": true,
      "mutation": false,
      "dateIdentity": false,
      "sameReference": true,
      "signedZero": false
    }
  },
  {
    "symbol": "get",
    "args": [
      {
        "t": "obj",
        "keys": [
          "profile"
        ],
        "v": {
          "profile": {
            "t": "obj",
            "keys": [
              "name"
            ],
            "v": {
              "name": {
                "t": "null"
              }
            }
          }
        }
      },
      {
        "t": "str",
        "v": "profile.name"
      },
      {
        "t": "str",
        "v": "anonymous"
      }
    ],
    "thisArg": {
      "t": "fn",
      "name": "lodash",
      "length": 1
    },
    "threw": null,
    "result": {
      "t": "null"
    },
    "hyrum": {
      "errorMessage": false,
      "toString": false,
      "json": false,
      "nan": false,
      "sparseArray": true,
      "keyOrder": false,
      "prototype": true,
      "mutation": false,
      "dateIdentity": false,
      "sameReference": true,
      "signedZero": false
    }
  },
  {
    "symbol": "get",
    "args": [
      {
        "t": "obj",
        "keys": [
          "profile"
        ],
        "v": {
          "profile": {
            "t": "obj",
            "keys": [
              "name"
            ],
            "v": {
              "name": {
                "t": "str",
                "v": ""
              }
            }
          }
        }
      },
      {
        "t": "str",
        "v": "profile.name"
      },
      {
        "t": "str",
        "v": "anonymous"
      }
    ],
    "thisArg": {
      "t": "fn",
      "name": "lodash",
      "length": 1
    },
    "threw": null,
    "result": {
      "t": "str",
      "v": ""
    },
    "hyrum": {
      "errorMessage": false,
      "toString": false,
      "json": false,
      "nan": false,
      "sparseArray": true,
      "keyOrder": false,
      "prototype": true,
      "mutation": false,
      "dateIdentity": false,
      "sameReference": true,
      "signedZero": false
    }
  },
  {
    "symbol": "get",
    "args": [
      {
        "t": "obj",
        "keys": [
          "a"
        ],
        "v": {
          "a": {
            "t": "obj",
            "keys": [
              "b"
            ],
            "v": {
              "b": {
                "t": "obj",
                "keys": [
                  "c"
                ],
                "v": {
                  "c": {
                    "t": "num",
                    "v": 1
                  }
                }
              }
            }
          }
        }
      },
      {
        "t": "str",
        "v": "a.b"
      }
    ],
    "thisArg": {
      "t": "fn",
      "name": "lodash",
      "length": 1
    },
    "threw": null,
    "result": {
      "t": "ref",
      "id": 2
    },
    "hyrum": {
      "errorMessage": false,
      "toString": false,
      "json": false,
      "nan": false,
      "sparseArray": true,
      "keyOrder": false,
      "prototype": true,
      "mutation": false,
      "dateIdentity": false,
      "sameReference": true,
      "signedZero": false
    }
  },
  {
    "symbol": "get",
    "args": [
      {
        "t": "obj",
        "keys": [
          "a"
        ],
        "v": {
          "a": {
            "t": "obj",
            "keys": [
              "b"
            ],
            "v": {
              "b": {
                "t": "obj",
                "keys": [
                  "c"
                ],
                "v": {
                  "c": {
                    "t": "num",
                    "v": 1
                  }
                }
              }
            }
          }
        }
      },
      {
        "t": "arr",
        "v": [
          {
            "t": "str",
            "v": "a"
          },
          {
            "t": "str",
            "v": "b"
          }
        ],
        "holes": []
      }
    ],
    "thisArg": {
      "t": "fn",
      "name": "lodash",
      "length": 1
    },
    "threw": null,
    "result": {
      "t": "ref",
      "id": 2
    },
    "hyrum": {
      "errorMessage": false,
      "toString": false,
      "json": false,
      "nan": false,
      "sparseArray": true,
      "keyOrder": false,
      "prototype": true,
      "mutation": false,
      "dateIdentity": false,
      "sameReference": true,
      "signedZero": false
    }
  },
  {
    "symbol": "get",
    "args": [
      {
        "t": "obj",
        "keys": [
          "a"
        ],
        "v": {
          "a": {
            "t": "obj",
            "keys": [
              "b"
            ],
            "v": {
              "b": {
                "t": "obj",
                "keys": [
                  "c"
                ],
                "v": {
                  "c": {
                    "t": "num",
                    "v": 1
                  }
                }
              }
            }
          }
        }
      },
      {
        "t": "str",
        "v": "a.b"
      }
    ],
    "thisArg": {
      "t": "fn",
      "name": "lodash",
      "length": 1
    },
    "threw": null,
    "result": {
      "t": "ref",
      "id": 2
    },
    "hyrum": {
      "errorMessage": false,
      "toString": false,
      "json": false,
      "nan": false,
      "sparseArray": true,
      "keyOrder": false,
      "prototype": true,
      "mutation": false,
      "dateIdentity": false,
      "sameReference": true,
      "signedZero": false
    }
  },
  {
    "symbol": "get",
    "args": [
      {
        "t": "obj",
        "keys": [
          "a"
        ],
        "v": {
          "a": {
            "t": "obj",
            "keys": [
              "b"
            ],
            "v": {
              "b": {
                "t": "obj",
                "keys": [
                  "c"
                ],
                "v": {
                  "c": {
                    "t": "num",
                    "v": 1
                  }
                }
              }
            }
          }
        }
      },
      {
        "t": "arr",
        "v": [
          {
            "t": "str",
            "v": "a"
          },
          {
            "t": "str",
            "v": "b"
          }
        ],
        "holes": []
      }
    ],
    "thisArg": {
      "t": "fn",
      "name": "lodash",
      "length": 1
    },
    "threw": null,
    "result": {
      "t": "ref",
      "id": 2
    },
    "hyrum": {
      "errorMessage": false,
      "toString": false,
      "json": false,
      "nan": false,
      "sparseArray": true,
      "keyOrder": false,
      "prototype": true,
      "mutation": false,
      "dateIdentity": false,
      "sameReference": true,
      "signedZero": false
    }
  },
  {
    "symbol": "debounce",
    "args": [
      {
        "t": "null"
      },
      {
        "t": "num",
        "v": 10
      }
    ],
    "thisArg": {
      "t": "fn",
      "name": "lodash",
      "length": 1
    },
    "threw": {
      "name": "TypeError",
      "message": "Expected a function"
    },
    "result": null,
    "hyrum": {
      "errorMessage": true,
      "toString": false,
      "json": false,
      "nan": false,
      "sparseArray": false,
      "keyOrder": false,
      "prototype": false,
      "mutation": false,
      "dateIdentity": false,
      "sameReference": false,
      "signedZero": false
    }
  },
  {
    "symbol": "get",
    "args": [
      {
        "t": "obj",
        "keys": [
          "profile"
        ],
        "v": {
          "profile": {
            "t": "obj",
            "keys": [
              "name"
            ],
            "v": {
              "name": {
                "t": "str",
                "v": "Ada"
              }
            }
          }
        }
      },
      {
        "t": "str",
        "v": "profile.name"
      },
      {
        "t": "str",
        "v": "anonymous"
      }
    ],
    "thisArg": {
      "t": "fn",
      "name": "lodash",
      "length": 1
    },
    "threw": null,
    "result": {
      "t": "str",
      "v": "Ada"
    },
    "hyrum": {
      "errorMessage": false,
      "toString": false,
      "json": false,
      "nan": false,
      "sparseArray": true,
      "keyOrder": false,
      "prototype": true,
      "mutation": false,
      "dateIdentity": false,
      "sameReference": true,
      "signedZero": false
    }
  },
  {
    "symbol": "get",
    "args": [
      {
        "t": "obj",
        "keys": [
          "a"
        ],
        "v": {
          "a": {
            "t": "obj",
            "keys": [
              "b"
            ],
            "v": {
              "b": {
                "t": "obj",
                "keys": [
                  "c"
                ],
                "v": {
                  "c": {
                    "t": "num",
                    "v": 7
                  }
                }
              }
            }
          }
        }
      },
      {
        "t": "str",
        "v": "a.b"
      }
    ],
    "thisArg": {
      "t": "fn",
      "name": "lodash",
      "length": 1
    },
    "threw": null,
    "result": {
      "t": "ref",
      "id": 2
    },
    "hyrum": {
      "errorMessage": false,
      "toString": false,
      "json": false,
      "nan": false,
      "sparseArray": true,
      "keyOrder": false,
      "prototype": true,
      "mutation": false,
      "dateIdentity": false,
      "sameReference": true,
      "signedZero": false
    }
  },
  {
    "symbol": "get",
    "args": [
      {
        "t": "obj",
        "keys": [
          "a"
        ],
        "v": {
          "a": {
            "t": "obj",
            "keys": [
              "b"
            ],
            "v": {
              "b": {
                "t": "obj",
                "keys": [
                  "c"
                ],
                "v": {
                  "c": {
                    "t": "num",
                    "v": 7
                  }
                }
              }
            }
          }
        }
      },
      {
        "t": "arr",
        "v": [
          {
            "t": "str",
            "v": "a"
          },
          {
            "t": "str",
            "v": "b"
          }
        ],
        "holes": []
      }
    ],
    "thisArg": {
      "t": "fn",
      "name": "lodash",
      "length": 1
    },
    "threw": null,
    "result": {
      "t": "ref",
      "id": 2
    },
    "hyrum": {
      "errorMessage": false,
      "toString": false,
      "json": false,
      "nan": false,
      "sparseArray": true,
      "keyOrder": false,
      "prototype": true,
      "mutation": false,
      "dateIdentity": false,
      "sameReference": true,
      "signedZero": false
    }
  }
];


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

function seedIdentity(v, seen) {
  if (v === null || (typeof v !== "object" && typeof v !== "function")) return;
  if (seen.has(v)) return;
  seen.set(v, v);
  if (v instanceof Date || v instanceof RegExp || v instanceof Error) return;
  if (Array.isArray(v)) {
    for (const el of v) seedIdentity(el, seen);
    return;
  }
  if (v instanceof Map) {
    for (const [k, val] of v) {
      seedIdentity(k, seen);
      seedIdentity(val, seen);
    }
    return;
  }
  if (v instanceof Set) {
    for (const el of v) seedIdentity(el, seen);
    return;
  }
  for (const k of Reflect.ownKeys(v)) seedIdentity(v[k], seen);
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
  if (ctx.toString) {
    const sa = customToString(a);
    const sb = customToString(b);
    if (sa !== sb) return false;
  }
  if (ctx.prototype && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Date && b instanceof Date) {
    const at = a.getTime();
    const bt = b.getTime();
    if (Number.isNaN(at) && Number.isNaN(bt)) return true;
    return at === bt;
  }
  if (a instanceof Date || b instanceof Date) return false;
  if (isUrlLike(a) && isUrlLike(b)) return a.href === b.href;
  if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
  if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) {
    if (a.byteLength !== b.byteLength) return false;
    return eqDeep(new Uint8Array(a), new Uint8Array(b), ctx, seen);
  }
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    if (a.byteLength !== b.byteLength) return false;
    const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    return true;
  }
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

function customToString(v) {
  const ts = v && v.toString;
  if (typeof ts !== "function") return undefined;
  if (ts === Object.prototype.toString || ts === Array.prototype.toString) return undefined;
  try { return String(v); } catch { return undefined; }
}

function standingCtx(hyrum) {
  return {
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
}

function standingEqual(a, b, hyrum) {
  const ctx = standingCtx(hyrum);
  if (!eqDeep(a, b, ctx, new WeakMap())) return false;
  return extras(a, b, ctx);
}

function isUrlLike(v) {
  return Boolean(v && typeof v === "object" && typeof v.href === "string" && typeof v.hostname === "string");
}

function callFn(fn, thisArg, args) {
  try {
    return { ok: true, value: fn.apply(thisArg, args) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/without ['"]?new['"]?/i.test(msg) || /Class constructor/i.test(msg)) {
      try {
        return { ok: true, value: Reflect.construct(fn, args) };
      } catch (err2) {
        return { ok: false, err: err2 };
      }
    }
    return { ok: false, err };
  }
}

function eq(actual, expected, hyrum) {
  if (!standingEqual(actual, expected, hyrum)) {
    throw new Error("standing mismatch");
  }
}

function invalidUrlTypeError(a, b) {
  if (a.name !== "TypeError") return false;
  const norm = (m) => m.replace(/^Invalid URL(?::[\s\S]*)?$/, "Invalid URL");
  return norm(a.message) === "Invalid URL" && norm(b.message) === "Invalid URL";
}

function equalThrown(a, b) {
  if (a.name !== b.name) return false;
  if (invalidUrlTypeError(a, b)) return true;
  return a.message === b.message && Object.is(a.code, b.code);
}

function checkAfter(live, p, ctx) {
  if (!p.argsAfter && p.thisAfter == null) return;
  const afterSeen = [];
  const expectedArgs = (p.argsAfter ?? []).map((a) => decode(a, afterSeen));
  const expectedThis = p.thisAfter != null ? decode(p.thisAfter, afterSeen) : undefined;
  const pairSeen = new WeakMap();
  if (p.thisAfter != null || live.thisArg != null) {
    if (!eqDeep(expectedThis, live.thisArg, ctx, pairSeen)) {
      throw new Error("standing receiver mutation mismatch for " + p.symbol);
    }
  }
  if (p.argsAfter) {
    if (expectedArgs.length !== live.args.length) {
      throw new Error("standing args mutation mismatch for " + p.symbol);
    }
    for (let i = 0; i < expectedArgs.length; i++) {
      if (!eqDeep(expectedArgs[i], live.args[i], ctx, pairSeen)) {
        throw new Error("standing args mutation mismatch for " + p.symbol);
      }
    }
  }
}

function checkFrozenPair(fn, p) {
  const live = reviveEvent(p);
  const hyrum = p.hyrum ?? {};
  const ctx = standingCtx(hyrum);
  if (p.threw) {
    const called = callFn(fn, live.thisArg, live.args);
    if (called.ok) throw new Error("expected throw " + p.threw.name);
    const err = called.err;
    const got = err instanceof Error
      ? { name: err.name, message: err.message, code: err.code }
      : { name: "Error", message: String(err) };
    if (!equalThrown(got, p.threw)) {
      throw new Error("error mismatch: " + got.name + ":" + got.message);
    }
    if (p.threw.code !== undefined && !Object.is(got.code, p.threw.code) && !invalidUrlTypeError(got, p.threw)) {
      throw new Error("error code mismatch");
    }
    checkAfter(live, p, ctx);
    return;
  }
  const called = callFn(fn, live.thisArg, live.args);
  if (!called.ok) throw called.err;
  const got = called.value;
  const identity = hyrum.sameReference === true || hyrum.dateIdentity === true;
  if (identity) {
    const pairSeen = new WeakMap();
    seedIdentity(live.thisArg, pairSeen);
    for (const a of live.args) seedIdentity(a, pairSeen);
    if (!eqDeep(live.result, got, ctx, pairSeen) || !extras(live.result, got, ctx)) {
      throw new Error("standing identity mismatch for " + p.symbol);
    }
  } else if (!standingEqual(got, live.result, hyrum)) {
    throw new Error("standing mismatch for " + p.symbol);
  }
  checkAfter(live, p, ctx);
}

test("slim lodash frozen pairs", () => {
  for (const p of pairs) {
    const fn = (slim as Record<string, unknown>)[p.symbol];
    if (typeof fn !== "function") continue;
    checkFrozenPair(fn as Function, p);
  }
});

test("debounce trailing-single", () => {
  const clock = createStandingClock();
  try {
    const debounce = (slim as { debounce: Function }).debounce;
    let n = 0;
    let last: unknown;
    const d = debounce((x: unknown) => { n++; last = x; }, 32);
    d("a");
    clock.advance(32);
    eq(n, 1);
    eq(last, "a");
  } finally {
    clock.restore();
  }
});

test("debounce cancel-mid", () => {
  const clock = createStandingClock();
  try {
    const debounce = (slim as { debounce: Function }).debounce;
    let n = 0;
    const d = debounce(() => { n++; }, 32);
    d("nope");
    clock.advance(10);
    d.cancel();
    clock.advance(32);
    eq(n, 0);
  } finally {
    clock.restore();
  }
});

test("debounce flush-mid", () => {
  const clock = createStandingClock();
  try {
    const debounce = (slim as { debounce: Function }).debounce;
    let n = 0;
    let last: unknown;
    const d = debounce((x: unknown) => { n++; last = x; }, 32);
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

test("debounce flush-empty", () => {
  const clock = createStandingClock();
  try {
    const debounce = (slim as { debounce: Function }).debounce;
    let n = 0;
    const d = debounce(() => { n++; }, 32);
    const flushed = d.flush();
    eq(n, 0);
    eq(flushed, undefined);
  } finally {
    clock.restore();
  }
});


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
