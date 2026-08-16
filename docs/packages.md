# Slim package-support matrix

Sizes are Bundlephobia **min / gzip** for current latest as of 2026-08-15, unless noted. Slice sizes are estimates for a typical 1–5 function envelope, not a promise. Hardness is for that typical envelope, not the whole library.

**Rule:** Slim does not support a *package*. It supports an *envelope*. `inspect` tells you which.

## How to read hardness

| Grade | Meaning for v1 |
| --- | --- |
| easy | Generate + fuzz against the installed package. Ship it. |
| med | Generate if the envelope stays inside a documented subset. Otherwise refuse with the subset named. |
| hard | Do not claim v1. `inspect` explains what would have to be true. |

CVE cadence is why a small package can still be worth slicing: you delete the advisory surface, not just bytes.

---

## First wave (15)

Ranked for the Friday serverless engineer: bytes or CVE pain, 1–5 call-site functions, no native, no network/fs in a legal envelope.

| # | Package | Typical slice | Original min / gz | Slim (est.) | Hardness | Why it matters on Workers / Lambda |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **lodash** | `get`, `pick`, `debounce` | 71.0 kB / 25.8 kB (`4.17.21`) | ~1.8 kB / 0.9 kB (~250 lines for get+debounce) | easy–med | The demo. `require('lodash')` does not tree-shake. Prototype-pollution history. Unbundled Lambda still copies ~1.4 MB unpacked onto the image. Golden fixture: `fixtures/lodash-get-debounce/`. |
| 2 | **whatwg-url** | `new URL(...)` | 470.9 kB / 168.5 kB | **0** (use global `URL`) | easy | Worst size/function ratio in the wave. Pulled by `node-fetch` / jsdom. The IDNA table (`tr46`) is the body. Workers and Node 20 already have `URL`. |
| 3 | **mime-types** (via **mime-db**) | `lookup('json')` / `contentType('html')` for 2–10 types | 162.5 kB / 24.1 kB | ~0.4 kB | easy | A JSON encyclopedia of every MIME type ever, to answer `.json → application/json`. |
| 4 | **validator** | `isEmail`, `isUUID`, `escape` | 125.2 kB / 39.2 kB | 2–8 kB | med | Auth/form Workers. `isEmail` is a rabbit hole (RFC + Gmail). v1 oracles against validator for *your* strings plus a fixture corpus, and says so on the tin. |
| 5 | **cron-parser** | `parseExpression(expr).next()` | 100.0 kB / 29.8 kB | 4–8 kB | med | Almost all the weight is `luxon`. Scheduled Workers often need “next run,” not a datetime framework. |
| 6 | **bluebird** | `Promise.delay`, `Promise.map` | 79.0 kB / 22.4 kB | ~0.8 kB | easy | A promises library in 2026. Native `Promise` + a loop. Cancellation / `promisifyAll` is out of envelope. |
| 7 | **date-fns** (barrel import only) | `format`, `differenceInDays` | 72.1 kB / 17.9 kB | ~2 kB | easy | Already modular. Slim only fires if they import from `'date-fns'` / `'date-fns/fp'` as a barrel. Named `date-fns/format` is already slim. Scan will say “already tree-shaken” and skip. |
| 8 | **crypto-js** | `SHA256` / `MD5` / `HmacSHA256` | 65.6 kB / 23.8 kB | ~0.3 kB (Web Crypto) | easy (hash) / hard (ciphers) | Hash-of-a-string on a Worker. Web Crypto is there. AES/PBKDF2/OpenSSL-KDF compatibility is a later envelope. |
| 9 | **moment** | `moment(x).format('YYYY-MM-DD')` | 60.6 kB / 19.7 kB; **~300 kB** with locales | 1–3 kB | med (format) / hard (locales, plugins, `.tz`) | Abandoned, still everywhere, locales blow the isolate. v1: format/parse of ISO-like strings. Locales, `moment-timezone`, mutability plugins: refuse. |
| 10 | **js-yaml** | `load` of JSON-like maps | 57.6 kB / 17.4 kB | 8–15 kB | med–hard | Edge config parsing. YAML 1.1 types, merge keys, custom tags: refuse. If the file is JSON-in-YAML, say that and generate a thin loader. |
| 11 | **ramda** | `pick`, `path`, `omit` | 55.1 kB / 14.4 kB | ~1 kB | med | Tree-shaking dies when they do `import * as R`. Same playbook as lodash. |
| 12 | **jsonwebtoken** | `verify` HS256 / RS256, or `decode` | 54.5 kB / 16.1 kB (pulls `semver` ~27 kB unpacked) | 2–4 kB | med | Auth Workers. v1 uses Web Crypto. Algorithm `none`: never implemented. `sign` with PEM on a Worker: allowed only if envelope is that narrow; still flagged in evidence. |
| 13 | **qs** | `parse`, `stringify` | 40.9 kB / 12.7 kB (+ `object-inspect` tree) | 3–6 kB | med | Query APIs. Prototype-pollution CVEs. v1: depth cap, no proto keys, arrays. `allowPrototypes: true` in a call site: refuse. |
| 14 | **async** | `parallel`, `retry`, `mapLimit` | 21.9 kB / 7.6 kB | ~0.8 kB | easy | Native promises. High confidence, mid size. Good second PR after lodash. |
| 15 | **uuid** | `v4` / `v7` | 10.2 kB / 3.8 kB | **0** (`crypto.randomUUID`) or ~0.4 kB for v7 | easy | Not the fattest. It is the cleanest delete. Request IDs on every Worker. Native `randomUUID` is RFC 4122 v4. |

Siblings, same generators, not extra ranks:

- `lodash-es`, `lodash.get`, `lodash.debounce`, … collapse into one slice.
- `underscore` uses the lodash generator.
- `query-string` uses the qs generator (simpler default).
- `mime-db` without `mime-types` is the same MIME map.
- `url-parse`, `whatwg-url`, Node `url` polyfills → global `URL`.
- `jwt-decode` (1.1 kB / 0.6 kB) is the decode-only envelope of `jsonwebtoken`. Still worth doing: one less advisory surface.

### What “typical slice” is allowed to miss

v1 generators implement the options **observed at call sites**, not the README.

| Package | Implemented in v1 if call sites use it | Refuse if call sites use |
| --- | --- | --- |
| lodash | `get`, `pick`, `omit`, `debounce` (trailing), `throttle`, `isEqual` (JSON-like), `clone`/`cloneDeep` (plain data), `uniq`, `compact`, `chunk`, `groupBy` (iteratee = string) | `_.template`, `_.chain` / implicit chaining, `fp`, `mixin`, `bind` with placeholders, `cloneDeep` with customizer, `set` with `__proto__` paths |
| moment | `format` with a fixed token string, `valueOf`, ISO parse | locale packs, `moment.tz`, plugins, `updateLocale` |
| crypto-js | `SHA256`, `SHA1`, `MD5`, `HmacSHA256`, `enc.Hex` / `Base64` | AES/TripleDES/Rabbit, OpenSSL KDF, streaming |
| qs | parse/stringify, `arrayLimit`, `depth` ≤ 5 | `allowPrototypes`, `decoder` functions, `plainObjects` + constructor tricks |
| validator | `isUUID`, `isISO8601`, `isIn`, `escape`, `isEmail` (oracle-bounded) | `isEmail` with `{allow_utf8_local_part, host_blacklist, …}` we did not capture; `normalizeEmail` |
| jsonwebtoken | `decode`; `verify` HS256/RS256 | `none`, nested JWT encryption, clocks we cannot skew-test |
| bluebird | `map`, `each`, `delay`, `filter` | cancellation, `promisifyAll`, coroutines |
| js-yaml | `load` JSON-like, `dump` plain objects | `!!js/function`, schema extensions, merge `<<` |
| cron-parser | 5-field cron, `next()` / `prev()` UTC | tz via luxon, 6/7-field with seconds if not in envelope |
| ramda | `pick`, `omit`, `path`, `pathOr`, `identity` | transducers, placeholder `__` deep composition we cannot bound |

---

## Near-wave (not v1, not refuse)

These are slimmable and painful, but the envelope is a project.

| Package | min / gz | Why wait |
| --- | --- | --- |
| marked / markdown-it | ~40 kB+ | XSS. A wrong parser is a security product, not a size trick. |
| ajv | large | JSON Schema compiler. Size win is real on edge. Correctness is the product. |
| handlebars / mustache | medium | Fine if we *compile* the templates they ship and inline the render function. That’s a different generator. |
| minimatch / micromatch | 24.5 kB / 8.8 kB | Brace expansion and extglobs. More of a build-tool dep than a Worker dep. |
| path-to-regexp | medium | Route DSLs. Worth it for edge routers; needs a fixture corpus of paths. |
| he / entities | small–med | HTML entities. Easy, low drama. Do it when the generator is generic enough. |
| papaparse / csv-parse | med | CSV dialects. |
| fast-xml-parser | med | XML. Same “wrong parser” problem as markdown. |
| semver | ~range grammar | `jsonwebtoken` already drags it in. A `satisfies` slice is med. |

Tiny packages Slim *can* replace (supply-chain, not bytes): `ms` (1.5 / 0.7), `cookie`, `escape-html` (0.6 / 0.4), `deepmerge` (1.7 / 0.7), `nanoid`. `scan` hides them unless `--all`. A CVE in `ms` is still a Friday.

---

## Refuse in v1 (and the error the human sees)

Every refuse error is the same shape: **what / why / evidence / what to do instead**. Never “unsupported.” Never a stack trace as the message.

### Frameworks and runtimes

`react`, `react-dom`, `preact`, `vue`, `svelte`, `solid-js`, `next`, `nuxt`, `remix`, `hono` (keep it; it is already slim), `express`, `koa`, `fastify`, `nestjs`.

```
error: slim will not replace 'react'

  React is a runtime, not a function you call twice.
  Envelope would include the reconciler, which is not a slice.

  package: react@18.3.1
  reason: framework

  Keep React. Slim is for lodash-shaped dependencies.
```

### Data / codegen / query engines

`prisma`, `@prisma/client`, `drizzle-orm`, `knex`, `sequelize`, `typeorm`, `mongoose`, `graphql` (the server), `@apollo/client`.

```
error: slim will not replace 'prisma'

  Prisma is a client generated from a schema, talking to a database.
  That envelope includes network I/O and generated engines.

  reason: io-client

  Keep Prisma. If the pain is bundle size on a Worker, Prisma does not
  belong on that Worker.
```

### Cloud SDKs

`aws-sdk` (v2), `aws-sdk/*`, `@aws-sdk/client-*`, `@google-cloud/*`, `@azure/*`, `firebase-admin`, `@anthropic-ai/sdk`, `openai` (the official SDK).

```
error: slim will not replace 'aws-sdk'

  The AWS SDK is a generated HTTP client for hundreds of services.
  Envelope includes network. A 90-line file would not be the AWS SDK.

  reason: network-sdk
  also: v2 is multiple megabytes. The upstream fix is @aws-sdk/client-*
  for the one service you call, or a signed fetch. Slim will not invent that.
```

### Native bindings

Anything with `.node`, `binding.gyp`, `prebuild`, `node-gyp-build`, `optionalDependencies` that install platform binaries, `sharp`, `canvas`, `bcrypt`, `argon2`, `sqlite3`, `better-sqlite3`, `grpc`, `zeromq`, `fsevents`, `esbuild` (as a library to slice), `swc`.

```
error: slim will not replace 'sharp'

  sharp loads native bindings (.node). A JavaScript slice would not be sharp.

  package: sharp@0.33.5
  reason: native-bindings
  found:  vendor/sharp-*.node, binding.gyp

  Keep sharp on Node (Lambda x86/arm). On Workers, use an image service.
```

### PDF / browsers / headless

`pdfkit`, `pdfjs-dist`, `pdf-lib` (maybe later; not v1), `puppeteer`, `playwright`, `jsdom`, `cheerio` (later), `monaco-editor`, `shiki`.

```
error: slim will not replace 'pdfkit'

  PDF generation is a document runtime (fonts, streams, binary).
  reason: document-runtime
```

### Envelope includes network or fs

Detected from the package, or from *your call sites*.

Network: `axios`, `got`, `node-fetch`, `undici`, `ky`, `superagent`, `request`, `ioredis`, `redis`, `pg`, `mysql2`, `mongodb`, `ws`, `socket.io`, `nodemailer`.

fs: `fs-extra`, `glob`, `globby`, `fast-glob`, `chokidar`, `dotenv`, `cosmiconfig`, `rimraf`, `mkdirp`, `tar`, `archiver`.

child_process: `execa`, `cross-spawn`, `shelljs`.

```
error: slim will not replace 'axios'

  HTTP clients have network in the envelope. Slim does not slice I/O.

  package: axios@1.19.0
  reason: envelope-network
  your call sites: src/client.ts:12 axios.get(...)

  Workers and Node 18+ already have fetch.
  Slim will not rewrite axios to fetch in v1 (that's a different tool).
  Do it by hand, or keep axios.
```

```
error: slim will not replace 'dotenv'

  dotenv reads the filesystem (and sometimes writes).
  reason: envelope-fs
  On Workers, use bindings / vars. On Lambda, use environment variables.
```

### Envelope too wide (the honest “not yet”)

```
error: slim will not replace 'lodash' as used here

  Call sites are wider than v1 will generate.

  package: lodash@4.17.21
  reason: envelope-too-wide
  exports used: get, pick, debounce, template, chain
  blocking:     template, chain

  v1 lodash slice: get, pick, omit, debounce, throttle, isEqual,
                   clone/cloneDeep (plain data), uniq, compact, chunk,
                   groupBy (string iteratee)

  What to do:
    - Stop using _.template / _.chain, then re-run: slim replace lodash
    - Or keep lodash
```

### Native / side-effectful at import

`core-js` (polyfill runtime), `regenerator-runtime`, `buffer` as a polyfill of Node `Buffer` (later), `process/browser`.

```
error: slim will not replace 'core-js'

  core-js patches the runtime. That is the opposite of a pure slice.
  reason: runtime-polyfill
```

---

## Scan ranking (what `slim scan` actually sorts by)

Not download counts. Per direct dependency:

```
score = bytes_into_bundle * (1 / max(used_exports, 1)) * shake_penalty * cve_boost
```

- **bytes_into_bundle:** for a bundled app (esbuild/wrangler), the package’s contribution after the project’s bundler if we can run it; otherwise Bundlephobia min. For unbundled Lambda, unpacked directory size.
- **shake_penalty:** 3× if CJS default import / `require('lodash')`; 1× if already named ESM.
- **cve_boost:** 2× if OSV has an advisory on the resolved version.

Hide packages under `--min-size` (default 5 kB min) unless `--all`.

Always list refuse-reasons in a second section: “fat, but Slim will not touch these.” Axios showing up there is the point.
