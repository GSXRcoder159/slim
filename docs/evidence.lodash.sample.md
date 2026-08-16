# Evidence: lodash@4.17.21 → src/slim/lodash.ts

**EVIDENCE, NOT PROOF.** Slim compared a new ~248-line file to lodash on random inputs
and on your call sites. You still read the file. Merge only if you accept the residual
risk below.

- Slim 0.1.0  ·  2026-08-15T20:41Z  ·  generated: synthesize  ·  oracle: node_modules/lodash@4.17.21

## What you used

2 call sites, 2 exports.

| Where | Call |
| --- | --- |
| `src/handler.ts:14` | `_.get(event, 'query.id')` |
| `src/handler.ts:41` | `debounce(flush, 50)` |

## What we wrote

Read this: **`src/slim/lodash.ts`** (~248 lines).

| File | Role |
| --- | --- |
| `src/slim/lodash.ts` | slice |
| `src/slim/lodash.test.ts` | standing tests (`node --test`) |
| `.slim/lodash/envelope.json` | envelope + hashes + upstream hints |
| `.slim/lodash/evidence.md` | this report |

Imports in `src/handler.ts` now point at the slice. `lodash` removed from package.json.

## Size

| | Before | After |
| --- | --- | --- |
| package (Bundlephobia min / gz) | 71.0 kB / 25.8 kB | 1.9 kB / 0.9 kB |
| this Worker (wrangler minify, gz) | 82.4 kB | 58.1 kB (−24.3 kB, −29%) |
| unpacked `node_modules/lodash` | 1.4 MB | 0 |

Cold start: Workers must finish isolate startup in 1s; this is fewer bytes to parse.
We did not measure CPU. Unbundled Lambda: 1.4 MB less to unzip/compile.

## What we ran

| Gate | Result |
| --- | --- |
| oracle fuzz `get` × 200 (plain objects, dotted paths, missing keys) | 0 mismatches vs lodash.get |
| oracle fuzz `debounce` | skipped as random timing; used lodash’s own debounce tests filtered to trailing-only (8) |
| standing tests | 12 pass |
| `npm test` | 3 pass |

Oracle is the copy of lodash that was in node_modules before uninstall.

## Envelope

- Pure functions. No `fs`, no network, no native addons, no `process.env`.
- Does not write `Object.prototype` / `Array.prototype`.
- `get(object, path)` — `path` is a string of `[.a-zA-Z0-9_]*` as in your call site. Array paths not implemented (you don’t use them).
- `debounce(fn, wait)` — trailing, last-call. No `leading`, no `maxWait`.
- Grep of the repo: no `leading:`, no `maxWait`, no `_.template`, no `_.chain`.

## Residual risk (always non-empty)

- This is **new code**, not a copy of `lodash/get.js`. A bug will look like Slim’s, not lodash’s.
- Fuzz used plain JSON-like objects. Host objects, getters that throw, and `__proto__` paths are not in the corpus. `get` throws on a path segment `__proto__` / `constructor` / `prototype` (lodash historically has gotten this wrong; we refuse those paths).
- `debounce` under fake timers / `wait=0` is not fuzzed; we copied the trailing cases from lodash’s tests.
- We did not prove the slice against future call sites. `slim check` fails if you start using `_.merge`.

## Upstream

`slim watch` will treat a lodash advisory as **exposing this slice** only if the patch
diff or GHSA text maps to `get` or `debounce`. A `_.template` CVE (today’s one) is
**not** an exposure. If watch cannot map the advisory to file names, it fails closed
and opens a human-review PR.

## Verdict

Merge if you accept residual risk. Read `src/slim/lodash.ts` first.
