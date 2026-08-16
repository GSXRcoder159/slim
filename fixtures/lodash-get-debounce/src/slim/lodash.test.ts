import { test } from "node:test";
import assert from "node:assert/strict";
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
    "threw": null,
    "result": {
      "t": "str",
      "v": "Ada"
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
    "threw": null,
    "result": {
      "t": "str",
      "v": "anonymous"
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
    "threw": null,
    "result": {
      "t": "str",
      "v": "anonymous"
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
    "threw": null,
    "result": {
      "t": "null"
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
    "threw": null,
    "result": {
      "t": "str",
      "v": ""
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
    "threw": null,
    "result": {
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
    "threw": null,
    "result": {
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
    "threw": null,
    "result": {
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
    "threw": null,
    "result": {
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
    "threw": {
      "name": "TypeError",
      "message": "Expected a function"
    },
    "result": null
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
    "threw": null,
    "result": {
      "t": "str",
      "v": "Ada"
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
    "threw": null,
    "result": {
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
    "threw": null,
    "result": {
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
];

function eq(actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected);
}
function eqThrows(fn: () => unknown, name: string, message: string): void {
  assert.throws(fn, (err: Error) => {
    assert.equal(err.name, name);
    assert.equal(err.message, message);
    return true;
  });
}

test("slim lodash frozen pairs", () => {
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
