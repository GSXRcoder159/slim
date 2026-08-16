# Slim

**Delete your dependencies.** Point Slim at a JS/TS repo. It infers the *usage envelope* of a heavyweight package — every call site, input shape, Hyrum accident — emits a dependency-free clean-room slice, differentially fuzzes original vs replacement, and opens a PR with standing evidence.

Differential fuzzing is **evidence, not proof**. That sentence is on the tin.

Slim is not affiliated with lodash, Underscore, OpenJS, Moment.js, or any target library. Generated files are original implementations. They do **not** inherit the upstream license. The original package is a CI-only oracle during `slim replace`; after merge it is gone.

## Friday afternoon

CVE on a library you use for two functions. Before standup:

```bash
npm i -g slim   # or npx slim
cd your-worker
slim doctor
slim scan
slim replace lodash
```

You get:

- `src/slim/lodash.ts` — readable in one sitting (~250 lines for `get` + `debounce`, not 300 methods). Golden Worker-shaped fixture: `fixtures/lodash-get-debounce/` (`wrangler.toml`, `src/worker.ts`).
- `.slim/lodash/evidence.md` — what was used, byte delta, fuzz counts, residual risk (never empty)
- standing tests that replay frozen I/O pairs **without** keeping lodash installed
- `lodash` removed from `package.json`
- a `gh` PR if GitHub CLI is on PATH

Stock lodash uses `Function(String)` and is rejected on Cloudflare/Vercel Edge. Tree-shaking does not fix that. The Worker cap that bites is **1s startup parse**, not gzip 3MB.

## Commands

```
slim scan [--json]
slim inspect <pkg>
slim replace <pkg> [--budget-ms 30000] [--no-trace] [--no-pr] [--allow-unknown] [--force] [--out src/slim]
slim check
slim upstream [--pr]
slim watch                  # alias of upstream
slim doctor
```

Exit codes: `0` ok · `1` fail · `2` usage · `3` refused / no catalog and no LLM key · `4` environment

## How it works

1. **Envelope** — the target repo's `typescript` walks imports and call sites. Unknowns (`_[k]()`, `eval`, `arr.map(get)`) are recorded, never guessed.
2. **Traces** — `node --import slim/hooks` for node:test; `slim/vitest` Vite plugin for Vitest. Jest is detect-and-document only.
3. **Generate** — verified catalog (lodash slice, moment format, uuid v4, ms, nanoid, clsx, …) or clean-room LLM. Catalog disagreements are Slim bugs; they are not LLM-patched.
4. **Fuzz** — original vs replacement, fake clock for debounce, in-house generators (no fast-check).
5. **Rewrite** — position splice of import specifiers. Untouched files stay byte-identical.
6. **Upstream** — `osv.dev` + npm latest. Unmapped advisories fail closed.

## Install

Node `>=22.18` (`module.registerHooks`). The target repo needs `typescript` as a devDependency.

```bash
npm i -D typescript
npx slim doctor
```

Zero runtime dependencies. Slim's own `package.json` `dependencies` is `{}`.

## LLM (optional)

Catalog covers the Friday path with no API key. For unknown slimmable packages:

```
ANTHROPIC_API_KEY=…           # or OPENAI_API_KEY
SLIM_LLM_MODEL=…              # optional
SLIM_LLM_BASE_URL=…           # optional
```

The generator receives envelope JSON plus public `.d.ts` / README **only**. Original `.js` is a guard-rail error.

## Vitest

```ts
// vitest.config.ts
import slimVitest from "slim/vitest";
export default { plugins: [slimVitest({ packages: ["lodash"] })] };
```

## Honest refusals

react, vue, next, prisma, typescript, eslint, webpack, vite, AWS SDK, firebase, sharp, better-sqlite3, canvas, puppeteer, playwright, pdf engines, axios / node-fetch / dotenv, native `.node` addons. Same error shape: what / why / evidence / what to do.

`_.template` / anything that needs `Function` is a refuse, not a sandbox hole.

## Legal

MIT for Slim. Catalog and generated slices: original work, SPDX MIT, “not derived from lodash/Underscore/OpenJS.” Do not attach upstream LICENSE files to generated output. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Cite

Hyrum's Law; McKeeman differential testing; Daikon (Ernst); Randoop (Pacheco); QuickCheck (Claessen/Hughes); MAPO API-usage mining.
