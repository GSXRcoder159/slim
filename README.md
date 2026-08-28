# Slim

**Delete your dependencies.** Point Slim at a JS/TS repo. It infers the *usage envelope* of a heavyweight package — every call site, input shape, Hyrum accident — emits a dependency-free slice, differentially fuzzes original vs replacement, and opens a PR with standing evidence.

Differential fuzzing is **evidence, not proof**. That sentence is on the tin.

Slim is not affiliated with lodash, Underscore, OpenJS, Moment.js, or any target library. Generated files are SPDX MIT original work; they do **not** inherit the upstream license. Do not attach upstream LICENSE files to generated output. n-gram similarity in CI is a heuristic, not a legal opinion. The original package is a CI-only oracle during `slim replace`; after merge it is gone.

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
- a GitHub PR if GitHub CLI (`gh`) is on PATH or `GITHUB_TOKEN` / `GH_TOKEN` is set

Stock lodash uses `Function(String)` and is rejected on Cloudflare/Vercel Edge. Tree-shaking does not fix that. Cloudflare isolate CPU is a **vendor** startup budget; Slim does not publish a measured Worker cold-start number. Node parse/size receipts for the golden slice live in [`docs/measurements.json`](docs/measurements.json).

## Commands

```
slim scan [dir] [--json]
slim inspect <pkg> [--json] [--allow-unknown]
slim replace <pkg> [--budget-ms 30000] [--no-trace] [--no-pr] [--dry-run] [--keep-original] [--no-install] [--allow-unknown] [--force] [--out src/slim] [--llm] [--template-only] [--max-attempts 3] [--allow-flaky] [--workers n] [--seed n]
slim check [pkg] [--json]
slim bloat
slim upstream [--pr] [--json]
slim watch                  # alias of upstream
slim doctor [--strict] [--json]
```

Exit codes: `0` ok · `1` fail · `2` usage · `3` refused / no catalog and no LLM key · `4` environment

`--json` is not global. It is supported on `scan`, `inspect`, `check`, `upstream`/`watch`, and `doctor`. `replace --json` and `bloat --json` are usage (exit 2). The advertised surface is [`docs/support-inventory.json`](docs/support-inventory.json).

## GitHub Actions

Published Actions (`slim-hq/slim/action/check@v1`, `bloat`, `upstream`) run only compiled distributable code. Missing or stale `dist/` is exit 4, not a source fallback. The release workflow publishes the exact packed tarball and attaches that pack to `vX.Y.Z` and `v1` so those tags contain `dist/`.

Every consumer workflow needs checkout, Node `>=22.18`, and `npm ci` before `uses:`. Copy [`docs/examples/slim-check.yml`](docs/examples/slim-check.yml), [`slim-bloat.yml`](docs/examples/slim-bloat.yml), and [`slim-watch.yml`](docs/examples/slim-watch.yml). The upstream Action needs `contents: write` and `pull-requests: write` plus `GITHUB_TOKEN` when it opens a PR.

## How it works

1. **Envelope** — the target repo's `typescript` walks imports and call sites. Unknowns (`_[k]()`, `eval`, `arr.map(get)`) are recorded, never guessed.
2. **Traces** — fail-closed. `node --import slim/hooks` for node:test; `slim/vitest` plugin for Vitest (named exports included). Jest is detect-only (no setup file). `--no-trace` is the only intentional static-only path and cannot claim trace closure.
3. **Generate** — verified catalog (lodash slice, moment format, uuid v4, ms, nanoid, clsx, …) or LLM from public `.d.ts`/README only. Catalog disagreements are Slim bugs; they are not LLM-patched.
4. **Fuzz** — original vs replacement, fake clock for debounce, in-house generators (no fast-check).
5. **Rewrite** — position splice of import specifiers. Untouched files stay byte-identical.
6. **Upstream** — `osv.dev` + npm latest. Unmapped advisories fail closed.

## Install

Node `>=22.18` (`module.registerHooks`). CI tests 22.18 and Active LTS 24 on Ubuntu, macOS, and Windows. Node 26 Current is not in CI until it is LTS. The target repo needs `typescript` as a devDependency.

```bash
npm i -D typescript
npx slim doctor
```

Zero runtime dependencies. Slim's own `package.json` `dependencies` is `{}`.

## LLM (optional)

Catalog covers the Friday path with no API key. For unknown slimmable packages:

```
OPENAI_API_KEY=…              # default when both keys are set
ANTHROPIC_API_KEY=…           # used when OPENAI_API_KEY is unset, or SLIM_LLM_BASE_URL is Anthropic
SLIM_LLM_MODEL=…              # optional; OpenAI default gpt-5.6-sol, Anthropic default claude-sonnet-4-5
SLIM_LLM_BASE_URL=…           # optional; a URL containing "anthropic" selects Anthropic
```

OpenAI uses the Responses API (`POST /v1/responses`), not Chat Completions.

The generator receives envelope JSON plus public `.d.ts` / README **only**, and only from the target package root (or `@types/<pkg>`). Traversal, absolute paths, and escaping symlinks in `types` / `typings` / `exports` / README are refused before any provider call. Original `.js`, source maps, and package tests are a guard-rail error. If no `.d.ts` or README exists, the prompt and evidence record that as an explicit limitation (envelope call sites only; no invented overloads).

LLM slices pass the same AST, export-contract, size, fuzz, standing-test, and evidence gates as catalog slices. Generated `Object.setPrototypeOf`, `__proto__` assignment, and `Object.defineProperty` on `*.prototype` fail before any project write. Catalog `defineData` may still define an own `__proto__` data property on a user object (hardening, not prototype mutation). Provider HTTP failures (timeout, 429, 5xx) exit 4. Unsafe or exhausted repairs exit 1. Nothing is written to the project until fuzz passes. Evidence records provider, model, prompt hash, attempts, and summarized counterexamples — never API keys.

Live packed `replace --llm` proof for advertised providers is `SLIM_LLM_LIVE=1` plus the matching API key. Live packed `upstream` proof for advertised OSV and npm-registry sources is `SLIM_UPSTREAM_LIVE=1`. Live packed `replace` PR proof is `SLIM_PR_LIVE=1` (GitHub CLI with repo create/push/PR plus `delete_repo`, or `SLIM_PR_TRANSFER_OWNER`) and `SLIM_RECEIPTS_DIR` for the receipt. Live packed Action proof for advertised check/bloat/upstream Actions is `SLIM_ACTION_LIVE=1` (same GitHub CLI plus a disposable consumer workflow on every advertised OS/Node cell). Missing credentials or missing current receipts fail `npm run qualify`; they do not vanish from `npm test`.

## Vitest

```ts
// vitest.config.ts
import slimVitest from "slim/vitest";
export default { plugins: [slimVitest({ packages: ["lodash"] })] };
```

## Honest refusals

react, vue, next, prisma, typescript, eslint, webpack, vite, AWS SDK, firebase, sharp, better-sqlite3, canvas, puppeteer, playwright, pdf engines, axios / node-fetch / dotenv, native `.node` addons. Same error shape: what / why / evidence / what to do.

`_.template` / anything that needs `Function` is a refuse, not a sandbox hole.

## Out of scope (v1)

Top-10,000 corpus scoring, billing/SaaS, merged-PR pricing, enterprise licensing, PDF generation, auto-merge, Node 26 CI, and catalog entries that are not listed in [`docs/packages.md`](docs/packages.md).

## Legal

MIT for Slim ([LICENSE](LICENSE)). Catalog and generated slices: SPDX MIT. Slim is not affiliated with upstream authors. n-gram similarity is a CI heuristic, not a legal opinion. Do not attach upstream LICENSE files to generated output. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Revert: [CHANGELOG.md](CHANGELOG.md).

## Cite

Hyrum's Law; McKeeman differential testing; Daikon (Ernst); Randoop (Pacheco); QuickCheck (Claessen/Hughes); MAPO API-usage mining.
