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

## Catalog in v1

Shipped catalog packages only. Slice sizes are estimates except where `docs/measurements.json` labels a field `measured`.

| Package | Typical slice | Original min / gz | Slim (est.) | Hardness |
| --- | --- | --- | --- | --- |
| **lodash** (+ `lodash-es`, per-method packages, `underscore`) | `get`, `pick`, `debounce` | 71.0 kB / 25.8 kB (`4.17.21`) | 6997 B / 2125 B gzip (`measured`, golden `get`+`debounce`) | easy–med |
| **whatwg-url** (`url-parse` → same) | `URL` / `URLSearchParams` | 470.9 kB / 168.5 kB | **0** (platform `URL`) | easy |
| **mime-types** (`mime-db`, `mime`) | `lookup` / `extension` allowlist | 162.5 kB / 24.1 kB | ~0.4 kB | easy |
| **bluebird** | `resolve`, `reject`, `all`, `race`, `delay`, `promisify` | 79.0 kB / 22.4 kB | ~0.8 kB | easy |
| **moment** | `moment(x).format('YYYY-MM-DD')` | 60.6 kB / 19.7 kB | 1–3 kB | med (format) |
| **uuid** | `v4` only | 10.2 kB / 3.8 kB | **0** (`crypto.randomUUID`) | easy |
| **ms** | single duration token | 1.5 / 0.7 | small | easy |
| **nanoid** | `nanoid` / `customAlphabet` | small | small | easy |
| **clsx** (`classnames`) | `clsx(...)` | small | small | easy |

Golden fixture: `fixtures/lodash-get-debounce/`.

### Registered catalog symbols

Every registered `allCatalogEntries()` id (typical-slice column above may stay short):

| Package | Symbols |
| --- | --- |
| lodash | `get`, `set`, `has`, `debounce`, `throttle`, `once`, `isEmpty`, `isNil`, `isEqual`, `pick`, `omit`, `clone`, `cloneDeep`, `map`, `filter`, `groupBy`, `uniq`, `compact`, `flatten`, `camelCase`, `kebabCase`, `snakeCase`, `identity`, `noop`, `defaultTo`, `chunk`, `take`, `head`, `first`, `last`, `keys`, `values`, `assign` |
| moment | `default`, `moment`, `createMoment` |
| uuid | `v4` |
| ms | `default`, `ms` |
| nanoid | `nanoid`, `customAlphabet`, `default` |
| clsx | `clsx`, `default` |
| whatwg-url | `URL`, `URLSearchParams`, `default` |
| bluebird | `resolve`, `reject`, `all`, `race`, `delay`, `promisify`, `Promise`, `default` |
| mime-types | `lookup`, `extension` |

Advertised aliases: `lodash-es`, `underscore`, `classnames`, `mime-db`, `mime`, `url-parse`, plus `lodash.<symbol>` per lodash symbol. `qs` / `query-string` are scan-family grouping only, not catalog.

### What “typical slice” is allowed to miss

v1 generators implement the options **observed at call sites**, not the README.

| Package | Implemented in v1 if call sites use it | Refuse if call sites use |
| --- | --- | --- |
| lodash | `get`, `pick`, `omit`, `debounce` (trailing), `throttle`, `isEqual` (JSON-like), `clone`/`cloneDeep` (plain data), `uniq`, `compact`, `chunk`, `groupBy` | `_.template`, `_.chain`, `fp`, `mixin` |
| moment | `format` with a fixed token string, `valueOf`, ISO parse | locale packs, `moment.tz`, plugins |
| uuid | `v4` | `v7`, `v1`, `validate` |
| ms | single duration token | compound strings |
| clsx / classnames | `clsx(...)` | none beyond public arity |
| mime-types | `lookup` / `extension` allowlist | `contentType`, types outside allowlist |
| whatwg-url | platform `URL` / `URLSearchParams` | `parseURL`, IDNA helpers |
| bluebird | `resolve`, `reject`, `all`, `race`, `delay`, `promisify` | `map`, `promisifyAll`, cancellation |
| nanoid | `nanoid` / `customAlphabet` with call-time CSPRNG | custom random other than platform CSPRNG |

## Not in v1 catalog

`inspect` will not emit a catalog slice for these. LLM may try if a key is set and the envelope is otherwise legal.

validator, cron-parser, date-fns, crypto-js, js-yaml, ramda, jsonwebtoken, qs, async, cookie, escape-html, deepmerge, query-string, jwt-decode.

## Near-wave (not v1, not refuse)

These are slimmable and painful, but the envelope is a project.

| Package | min / gz | Why wait |
| --- | --- | --- |
| marked / markdown-it | ~40 kB+ | XSS. A wrong parser is a security product, not a size trick. |
| ajv | large | JSON Schema compiler. |
| handlebars / mustache | medium | Compile-then-inline is a different generator. |
| minimatch / micromatch | 24.5 kB / 8.8 kB | Build-tool dep more than a Worker dep. |
| path-to-regexp | medium | Route DSLs. |
| he / entities | small–med | HTML entities. |
| papaparse / csv-parse | med | CSV dialects. |
| fast-xml-parser | med | XML. |
| semver | ~range grammar | Not a catalog target in v1. |

Tiny catalog packages: `ms` (single-token only), `nanoid`, `clsx` (`classnames` is the same catalog). `cookie`, `escape-html`, and `deepmerge` are **not** in the v1 catalog.

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

## Scan ranking (what `slim scan` actually reports)

Scan is an inventory, not a closed envelope. It does **not** score CVE boosts or wrangler/esbuild “into bundle” bytes (those belong to later phases).

Per third-party package name:

- **Sites** come from include/ignore-filtered source and count **runtime** import/export declarations only. `import type`, `export type`, and type-only named bindings are `typeOnlySites`, not `importSites`. Relative, absolute, URL, builtin, and `file:`/`workspace:` deps are omitted.
- **Version** is lockfile/`node_modules` exact, or `unknown` with `range-only` / `malformed` / `unavailable` — never a stripped `^` range pretending to be exact.
- **Verdict** `candidate` vs `review` is a ranking heuristic (known-large / few **runtime** sites). `refuse` is the refuse table. `unused` is declared with no runtime import (including type-only-only). Scan never emits `slim`.
- **Size provenance** is `measured` (complete unpacked walk, name not in the known min table), `estimated` (known min table after a complete install walk), `partial` (incomplete walk: cap, unreadable, omitted, broken or escaping link — including known-size packages), or `unknown` (no install tree, including known-size packages; table `minBytes` may still be present). Ranking still uses `BLOAT_PACKAGES` or `minBytes > 20_000` with few runtime sites; catalog estimates are independent of the walk. `gzipBytes` is always 0.36 × `minBytes` (a guess of the displayed min, not a second measurement). `sizeState: review` is measurement quality for a `partial` walk, not ranking `verdict: review`.

Human output lists unused and undeclared rows. `inspect` / `replace` close an envelope; scan does not.
