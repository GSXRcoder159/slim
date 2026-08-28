# Slim developer experience

Wedge: a serverless/edge engineer on a Friday. CVE in a library they use two functions of. They run `slim replace lodash`, read a slice readable in one sitting (~250 lines for get+debounce) plus an evidence report, merge before standup.

Money and billing are out of scope. There is no SaaS. Slim is a CLI plus three GitHub Actions that call that CLI. A `v*` tag publishes only when it matches `package.json` and CHANGELOG; the workflow publishes the packed tarball (never a rebuilt tree) and attaches compiled Action files to that version tag.

Parser: `node:util.parseArgs`. No commander, yargs, cac, meow. Subcommands are a `switch` on `positionals[0]`. Alias `watch` → `upstream`.

---

## 1. CLI surface

### Process contract

| Stream | Default | `--json` |
| --- | --- | --- |
| stdout | Human report (the thing you read) | One JSON value, no logs |
| stderr | Progress (`fuzz 400/1000`), warnings | Progress |
| GitHub Actions | Also emit `::error file=line::` / `::notice::` on stderr when `GITHUB_ACTIONS=1` | same |

`--json` never interleaves human lines on stdout. CI greps stdout or `jq`.

TTY: color on stdout/stderr when `isatty` and `NO_COLOR` unset. Never color JSON.

Confirmations: none. `--no-pr` skips GitHub. CI is non-interactive.

### Exit codes

| Code | When |
| --- | --- |
| 0 | Success. `watch`: slice not exposed. `check`: all standing tests + envelope match. `scan`: always 0 unless usage/internal (findings are data). |
| 1 | Operational failure: tests failed, malformed/oversize traces, envelope drifted, slice **exposed** or **uncertain** on an advisory, replace fuzz mismatch, branch collision, git commit/push/PR failed. |
| 2 | Usage. Help was printed to stderr. |
| 3 | Refused / envelope too wide / native / network / fs. Human-readable error already on stderr. |
| 4 | Environment: Node too old, network required but failed (OSV/npm), `gh` and `GITHUB_TOKEN` both missing when a PR is requested, no origin/unparseable GitHub remote, no `package.json`, Jest/no-runner/missing hook/timeout when traces are required. |

The shipped CLI uses **0–4 only**. SIGINT is the process default (typically 130), not a SlimExit.

`slim bloat` (and the bloat Action) flags production `BLOAT_PACKAGES` with no Slim replacement. Ignores `devDependencies` and import sites. Exit 0 when none remain; exit 1 when any remain. Not `scan --diff`. No PR comment path.

### Flags

`-h` / `--help` is accepted on every command.

`--json` is **not** global. It is supported on `scan`, `inspect`, `check`, `upstream`/`watch`, and `doctor` only. `replace --json` is a usage error (exit 2): usage on stderr and a `docs/error.schema.json` document on stdout. Successful replace machine output is `.slim/<pkg>/evidence.json`, `.slim/manifest.json`, and `slim.json` replacements. `bloat --json` is the same usage error.

`--version`, `--cwd`, `--quiet`, and `--verbose` are **not** shipped. `--help` with a command prints that command’s help and exits 0. Bare `slim` and `slim --help` print top-level help on stdout and exit 0. An unknown command prints `unknown command:` plus help on stderr and exits 2. Unsupported flags on a known command are usage (exit 2).

The advertised product surface is [`docs/support-inventory.json`](./support-inventory.json). Help and this file may name only those entries.

Qualification receipts live in gitignored `qualification/receipts/` and bind one commit plus the packed npm/Action content digest. `npm run artifacts` prints one schema-valid identity document (`docs/artifact-identity.schema.json`) for that commit. `npm run qualify:emit` writes local receipts after the named `checkId` tests pass; it will not mint an `osNode` cell for a different OS or Node. `npm run qualify:candidate` packs once, emits locals, runs live tests when `SLIM_*_LIVE=1`, and fail-closes. CI uploads six `osNode` receipts; `npm run qualify:candidate -- --mode collect --os-node-only` merges them. Missing or stale receipts fail `npm run qualify`; they do not vanish from `npm test`.

Shipped top-level help is the `HELP` string in `src/cli.ts` (`slim --help`). Keep [`help.txt`](./help.txt) equal to that string; `test/cli.test.ts` diffs them.

### `slim scan [dir]`

Inventory of third-party packages (declared deps plus imported undeclared names). Not an envelope. Findings are data; exit 0 unless usage/internal.

```
--json                One schema-valid document on stdout (docs/scan.schema.json)
```

Optional `[dir]` is a project directory. Relative imports, absolute paths, URLs, Node builtins, and `file:`/`workspace:`/`link:`/`portal:` packages are omitted. `import type` / `export type` / type-only named bindings are not runtime sites; a declared package used only for types is `unused` with `typeOnlySites > 0`. `verdict` is `candidate` | `review` | `refuse` | `unused` — never `slim` or `closed`. Size `minBytes` provenance is `measured` (complete unpacked walk, name not in the known min table), `estimated` (known min table after a complete install walk), `partial` (incomplete walk: cap, unreadable, omitted, broken or escaping link — including known-size packages; `sizeState` is `review`), or `unknown` (no install tree, including known-size packages; table `minBytes` may still be present). `gzipBytes` is always 0.36 × `minBytes` (a guess of the displayed min, not a second measurement). `sizeState: review` is measurement quality, not ranking `verdict: review`. Lockfile versions are `exact`, or `unknown` with `versionState` `range-only` / `malformed` / `unavailable`.

Stdout (human): a table of every row including unused and undeclared, with size provenance and type-only notes. JSON: `{ schemaVersion: 2, lockfile, rows }` with no absolute `root`. No `--all`, `--min-size`, `--diff`, `--fail`, or `--limit`.

Does not network. Size is local. A missing install is `unknown` provenance (catalog `minBytes` may still appear); an incomplete walk is `partial`, never `estimated` or `measured`.

### `slim inspect <pkg>`

One package. Writes `.slim/<pkg>/envelope.json` (replace depends on it). This is the “should I?” command.

```
    --json              One document: { schemaVersion, envelope, hash, decision, reason }
    --allow-unknown     Ready despite unknowns; never claims closed
```

Exit 0 if Slim would try (closed, or `--allow-unknown` made ready). Exit 3 if the envelope is open/incomplete or refused (still print the full inspect report; the code is the refuse). JSON mode does not mix progress on stdout.

`--force` does not claim closed. `--allow-unknown` may set `readyToGenerate` while `confidence` stays `open`. Unknown `kind` values include `dynamic-member`, `dynamic-specifier`, `spread-args`, `binding-escape`, `namespace-escape`, `eval`, `ts-any`, and `unresolved-shape` (object/array spreads and non-literal computed keys). `eval` widens to `refuse` and is not overridden by `--allow-unknown`.

### Hyrum substitution contract

Envelope `symbols[].hyrum` is a substitution contract, not descriptive metadata. Fuzz `equal` / `equalResults` and emitted standing tests use the same rules. Orig and slim each receive an isolated clone of the full args+receiver graph; internal aliases and cycles (`args[0] === args[1]`, `args[i] === thisArg`, nested shares) are preserved independently on each side. Nested input→result identity is enforced by pairing the same `WeakMap` across receiver, arguments, and return (not top-level `===` only). Standing tests decode `argsAfter` and `thisAfter` as one graph and pair expected→live the same way.

Gated (compared only when the flag is true — do not overclaim): `sameReference` (return aliases into args/`this` must be preserved; a structured clone of an observed nested return fails), `dateIdentity` (an input Date returned by identity must not be replaced by `new Date(t)`), `prototype` (`Object.getPrototypeOf`, including `Object.create(null)` vs `{}`), `keyOrder` (object key insertion order **and** Map/Set entry order), `signedZero` (`-0` vs `+0`), `toString` (`String(a) === String(b)`, including nested custom `toString`), `json` (`JSON.stringify`).

Always on (substitution safety; flags still recorded from traces): `nan` (NaN equals NaN, not `0`), `sparseArray` (holes vs dense `undefined`), `mutation` (post-call args **and** receiver), `errorMessage` (thrown `name` + `message` + `code`).

### `slim replace <pkg>`

The product.

```
      `--no-pr`            Write files; no branch, commit, push, or PR
    --no-trace          Static-only evidence (cannot claim trace-closed)
    --dry-run           Print the plan; write nothing (including traces)
    --keep-original     Do not uninstall the package
    --no-install        Rewrite package.json but skip lockfile refresh
    --out <dir>         Override slices dir (default src/slim)
    --force             Skip size / refuse heuristics; does not skip fuzz or merge-gate
    --llm               Force LLM even if catalog matches
    --template-only     Catalog only; refuse if the catalog cannot cover the envelope
    --max-attempts <n>  LLM repair loop (default 3)
```

Steps, in order, stop on first failure. After the first project write, failure **rolls back** the target tree: regular files (bytes and execute bits), newly created files and empty dirs, binary lockfiles, and symlinks (same `readlink` target). Escaping symlinks, a symlinked `--out` that leaves the project, output collisions, and special files (fifo/socket/device) are refused **before** any write; the project and any external target stay unchanged.

1. Resolve pkg in package.json / lockfile. Missing → exit 1.
2. Refuse gates (native, network, fs, framework, envelope-too-wide) → exit 3.
3. Build envelope from call sites.
4. Tracing (unless `--no-trace`): run detected node:test or Vitest with `slim/hooks` / `slim/vitest`. Trace artifacts go to a temp dir and are deleted; they are not written into the project until a successful replace records `.slim/<pkg>/traces.meta.json`. Jest, no runner, missing hook, or timeout → exit 4. Failed tests, malformed JSONL, oversize traces, zero package events, unmatched events, or serializer/export-star control errors → exit 1. A successful test command is not a successful package trace. `--force` does not skip tracing. `--no-trace` is static-only and cannot claim `trace-closed`. `--dry-run` still traces in a temp dir unless `--no-trace`.
5. Generate slice (catalog, or clean-room LLM when the catalog cannot cover the envelope and a key is set). Catalog disagreements are Slim bugs and are never LLM-patched. LLM input is envelope JSON plus `.d.ts`/README only, confined to the package root or `@types/<pkg>`; a types/typings/exports/README path that escapes is refused before any provider call. Missing specs are a named limitation. Repair counterexamples in prompts are length- and count-capped. AST allowlist (including no `Object.setPrototypeOf`, `__proto__` assignment, or prototype-target `defineProperty`), export/default/namespace/result-member contracts, then fuzz. Missing exports repair until `--max-attempts`. Unsafe AST does not repair. Provider HTTP 429/5xx/timeout → exit 4. Prose/empty/invalid JSON, unsafe code, or exhausted repair → exit 1. `--dry-run` prints the plan and exits 0 with no project writes. Advertised providers are `openai` (default when both keys are set; Responses API, model `gpt-5.6-sol`) and `anthropic` (`ANTHROPIC_API_KEY` without `OPENAI_API_KEY`, or `SLIM_LLM_BASE_URL` containing `anthropic`). Live packed `replace --llm` receipts are required by `npm run qualify` (`SLIM_LLM_LIVE=1` plus the matching key writes them under `SLIM_RECEIPTS_DIR` when set).
6. Fuzz slice against the installed original (oracle) using a temp module outside the project. `--budget-ms n` is an extra-case quota (`n` generated cases after traces, literal unions, and timer taxonomy) and a wall watchdog. Worker orig/slim load has a 2000ms startup allowance independent of `n`; each case timeout (capped at 5s) starts only after the worker posts ready; minimize is charged inside that case; pool close allows 250ms per worker. The run returns within `n + 2000 + 250` ms or fails closed (`timeout`, `insufficient startup`, crash, serialization). A planned work set that runs zero cases is `insufficient budget` (exit 4). `--workers` default is CPUs-1 (`1` = in-process). Same envelope, seed, budget, and worker count reproduce ordered disagreements, minimized inputs, and case/timer counts. Mismatch → exit 1, project unchanged.
7. Write slice (and a `.cjs` companion when CJS `require()` sites exist). Rewrite imports/requires to the slice. Remove only the replaced package and family siblings that have import sites in this envelope.
8. Refresh the lockfile with `npm install` / `pnpm install` / `yarn install` / `bun install`. Package-manager caches go to a temp dir (`os.tmpdir()/slim-pm-cache`); Slim does not create a store inside the target unless the project already had one. Failure → exit 1 (or 4 if the package manager is missing) and rollback, then a frozen install to restore `node_modules`. `--no-install` skips this. `--keep-original` skips package.json and lockfile changes.
9. Write evidence (including revert steps), standing tests, manifest, envelope. Run merge-gate (`testCommand` or `scripts.test`). Failure → rollback.
10. Unless `--no-pr`: after merge-gate, create `slim/<fileBase(pkg)>` from `HEAD` without switching the user's branch or writing `.git/index`. `fileBase` strips a leading `@` and replaces `/` with `-` (`lodash` → `slim/lodash`, `@scope/name` → `slim/scope-name`). Cross-check title, body (package, versions, envelope/evidence/module digests, fuzz stats), files, base, head, and labels (`slim`, `slim:replace`) against the accepted evidence before any push. Commit only Slim files, `git push` without `--force`, then `gh pr create --repo --base --head --label` or GitHub REST with `GITHUB_TOKEN`/`GH_TOKEN`. PRs target origin (not a fork parent). Local or remote branch collision, commit failure, push failure, and `gh`/REST failure are nonzero; the user's branch and index stay recoverable. Push failure deletes the local Slim branch; PR API failure also deletes the remote Slim branch. No `gh` and no token → exit 4 after local writes, with no git refs created. `--no-pr` performs no branch, commit, push, or network.

Default without `--no-pr`: attempt a PR after a successful merge-gate. There is no TTY confirm and no `--yes` / `--no-commit` flag.

(The Friday transcript under `docs/transcripts/` is **historical** and must not be read as the shipped CLI.)

### `slim check [pkg]`

CI. No network. No generation.

```
    --json              One schema-valid document on stdout (docs/check.schema.json)
```

For each recorded slice (or one pkg):

1. Re-analyze call sites. Fail on added symbols, new call shapes (arity, literals, options), new result members, new import forms, new env tags, or new unknowns — even when the symbol name is unchanged.
2. Fail on missing/malformed envelopes, missing/malformed evidence (including hash-only stubs), missing `.slim/manifest.json`, envelope hash mismatch vs evidence/manifest, version mismatch, or missing slice exports.
3. Run `scripts.slim:evidence` if set, else `src/slim/<pkg>.test.ts` via `node --test`. Missing standing tests fail. Missing `<slice>.hardened.test.ts` fails. Child test output is inherited in human mode and copied to stderr under `--json` so stdout stays one JSON document.
4. Fail if the slice, standing tests, or hardening tests import the original package.
5. Optional `testCommand`.

Empty replacements / no manifest → exit 0 (so adding the Action to a repo that has not slimmed yet is free). `--update-envelope` is not a flag; drift always fails.

JSON `{ schemaVersion, ok, exit, status, packages[] }` includes per-package `drift`, `standing`, and `residualRisk` from evidence. Human mode prints the same status and residual risk. Missing evidence is never treated as empty residual risk.

### `slim bloat`

No network. No `--json`. Scans `package.json` `dependencies` for `BLOAT_PACKAGES` without a recorded Slim replacement. `devDependencies` and import-only uses are ignored. Exit 0 prints `slim-bloat: ok`. Exit 1 lists the fat production deps. Same command the bloat Action runs.

### `slim upstream`  (`watch` is the alias)

```
    --pr                Open a PR if a slice is exposed or unmapped
    --json              One schema-valid document on stdout (docs/upstream.schema.json)
```

Network: OSV `POST /v1/query` and npm registry packument. GitHub is probed only with `--pr` (CLI or `GITHUB_TOKEN`) after replacement state is complete. Oracle install is probed only when regenerating an exposed slice. Any consulted OSV/npm/GitHub status of unavailable, timeout, malformed, or stale → exit 4 and never prints `slice not exposed.` Missing manifest, empty-invalid artifacts, or corrupt envelope/evidence/module/standing/hardening tests → exit 1, `incomplete-state`, never `not-exposed`. A valid empty replacement set → exit 0, `no replacements`. Unmapped advisories write `.slim/UPSTREAM.md` for human review and do not rewrite the slice. Exposed slices regenerate only after catalog/LLM validation, export/size/fuzz/standing/hardening/evidence/merge gates; all exposed packages share one transaction. No installable oracle leaves the tree unchanged (exit 1, `oracle-unavailable`). GitHub Advisory GraphQL, `querybatch`, `--fail-on`, and `--write-workflow` are not v1.

### `slim doctor`

`--strict` makes a dirty working tree exit 4. Default: list the dirty-tree issue and still exit 0 if Node and `registerHooks` are ok. Always prints a CJS hooks recommendation for Node >= 22.22.3. Exit 4 if Node < 22.18. Warnings (gh missing, no watch workflow, dirty tree without `--strict`) do not fail doctor. `--json` dumps `{ schemaVersion, ok, exit, status, …report }` including `dirtyTree` and `issues` (docs/doctor.schema.json).

### Command help (tired human)

Each `--help` is ≤ 40 lines. Verb first. One example. No “utilize.”

`slim replace --help`:

```
slim replace — write a verified slice and (usually) open a PR

Usage:
  slim replace <pkg> [options]

      --no-pr            Write files; no branch, commit, push, or PR
      --no-trace         Static-only evidence (cannot claim trace-closed)
      --dry-run          Show the envelope and plan, write nothing including traces
      --keep-original    Do not uninstall the package
      --no-install       Rewrite package.json but skip lockfile refresh
      --out <dir>        Default: src/slim

Exit: 0 wrote (and PR opened if requested). 1 tests/fuzz/lockfile/merge-gate/git commit/push/PR failed.
      3 Slim refuses this envelope. 4 missing gh and GITHUB_TOKEN when PR required, missing origin, or missing package manager.

Example:
  slim replace lodash
```

---

## 2. Magical moment (Friday 16:40)

Project: a Cloudflare Worker. `lodash@4.17.21`. GHSA out for `_.template` prototype pollution. They use `_.get` and `_.debounce`. Standup is 9:30.

### `slim scan`

```
$ slim scan
package                      relation              verdict     sites    types    min       size        note
lodash                       declared-imported     candidate   2        0        71.0kB    estimated
axios                        declared-imported     refuse      3        0        18.1kB    measured    network client — envelope is HTTP

1 candidate. Scan does not close an envelope. Run slim inspect <pkg> then slim replace <pkg>.
```

JSON (`--json`) is `{ schemaVersion: 2, lockfile, rows }`. See `docs/scan.schema.json`.

### `slim inspect lodash`

```
$ slim inspect lodash
lodash@4.17.21  MIT  71.0 kB min / 25.8 kB gz

  call sites (2)
    src/handler.ts:14  _.get(event, 'query.id')
    src/handler.ts:41  debounce(flush, 50)

  envelope
    exports:     get (arity 2), debounce (arity 2, trailing)
    not used:    template, chain, fp, proto-mutating helpers
    purity:      no fs, no net, no native, no Object.prototype writes
    decision:    TRY  (v1 lodash subset)

  what Slim will not implement (and you don't call)
    debounce leading, maxWait
    get path as function

  size (measured Node parse/size of the golden slice; see docs/measurements.json)
    package:     71.0 kB estimated original min  →  6997 B / 2125 B gzip replacement
    Worker gzip / cold-start CPU: not measured by Slim (vendor isolate budget).
    Unbundled Lambda `node_modules/lodash` directory size is not a Slim-published measurement.
    Oracle `lodash.js` bytes/gzip live in docs/measurements.json when lodash is installed.

  next:  slim replace lodash
```

### `slim replace lodash`

```
$ slim replace lodash
envelope         get, debounce
generate         src/slim/lodash.ts  (~250 lines)
oracle fuzz      (illustrative n/n; golden evidence.json is the receipt)
standing tests   12 pass
project tests    npm test  (3 pass)
imports          src/handler.ts
package.json     - lodash

  src/slim/lodash.ts
  src/slim/lodash.test.ts
  .slim/lodash/envelope.json
  .slim/lodash/evidence.md

Open PR after merge-gate (no TTY confirm)
branch  slim/lodash          (slim/<fileBase(pkg)>; scoped packages become slim/scope-name)
pr      https://github.com/acme/edge-api/pull/842

Read .slim/lodash/evidence.md (~90s) and src/slim/lodash.ts
then merge. This is evidence, not proof.
```

### Evidence (what they actually read)

See §8. They open `.slim/lodash/evidence.md`, then the ~250-line file. The PR body is the full evidence report. Worker-shaped golden fixture: `fixtures/lodash-get-debounce/`.

### Cold-start framing (print this, don’t overclaim)

Workers: isolate CPU is a **vendor** startup budget. Slim does not publish a measured Worker gzip or cold-start number. Node parse/size receipts: [`docs/measurements.json`](./measurements.json).

Lambda: **bundled** (esbuild) behaves like Workers. **Unbundled** `node_modules` is unzip + V8 compile. Slim publishes measured `lodash.js` bytes in [`docs/measurements.json`](./measurements.json) when that file is installed; it does not publish a full `node_modules/lodash` directory size.

v1 prints estimated original min and measured replacement bytes in evidence. No “50% faster p95.” No invented Worker gzip delta.

### After merge

`slim check` is in CI. `slim watch` is a Monday cron. The CVE in `_.template` does not apply. Watch says so.

---

## 5. GitHub Actions

Three composite actions (`check`, `bloat`, `upstream`) wrap the packed CLI via `action/run.mjs`. They execute only compiled `dist/github/*-action.js` whose SHA-256 (`actionSha256` in `dist/.slim-build.json`) matches the Action distributable. Missing or stale compiled files exit 4. There is no `--experimental-strip-types` source fallback.

Published `uses: slim-hq/slim/action/check@v1` requires the git ref to contain that compiled `dist/` (the same file set as `npm pack`). This repository gitignores `dist/`; dogfood workflows run `npm run build` then `uses: ./action/*`. A published tag without `dist/` is explicit non-success, not a silent source downgrade. The published upstream Action always sets `SLIM_UPSTREAM_PR=1` (opens a PR when a slice is exposed or unmapped). The CLI `--pr` flag remains optional.

Consumers must check out the project, set up Node >= 22.18, and install the project (`npm ci`) so `typescript` is resolvable. Copy [`docs/examples/slim-check.yml`](./examples/slim-check.yml), [`slim-bloat.yml`](./examples/slim-bloat.yml), and [`slim-watch.yml`](./examples/slim-watch.yml).

### `slim-check` (on every PR)

`.github/workflows/slim-check.yml` in the **user** repo:

```yaml
name: slim-check
on:
  pull_request:
  push:
    branches: [main]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22.18"
      - run: npm ci
      - uses: slim-hq/slim/action/check@v1
```

`action/check/action.yml` requires Node >= 22.18 and runs `slim check`. Fails the PR on envelope drift, missing evidence, missing standing/hardening tests, or a failing standing/hardening suite. No recorded replacements → pass.

### `slim-bloat` (optional, PRs that add fat deps)

```yaml
name: slim-bloat
on:
  pull_request:
jobs:
  bloat:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22.18"
      - run: npm ci
      - uses: slim-hq/slim/action/bloat@v1
```

Same semantics as `slim bloat`: production `BLOAT_PACKAGES` without a Slim replacement fail the job (exit 1). No `fail:` input. No PR comment.

### Watch workflow

This repository dogfoods `.github/workflows/slim-upstream.yml` (`npm run build`, `./action/upstream`, Monday `0 8 * * 1`). Consumer template: `docs/examples/slim-watch.yml` (`uses: slim-hq/slim/action/upstream@v1`, Monday `0 14 * * 1`, `GITHUB_TOKEN`). The cron values are independent schedules, not a product contract.

---

## 8. Evidence report (90 seconds)

File: `.slim/<pkg>/evidence.md`

Tone on line 1: **evidence, not proof.** If we write “safe” we have failed the product.

Target: a tired person, 90 seconds, then they open the slice. If the report is longer than ~80 lines, it is wrong.

### Sections, in this order

1. **Banner** — package, version, date, Slim version, `EVIDENCE NOT PROOF`.
2. **What you used** — exports + call sites (file:line). If more than 8 sites, first 8 + count.
3. **What we wrote** — paths, line count of the slice. “Read this file.”
4. **Size** — original min/gz, slice bytes, bundle delta if measured, unpacked delta if Lambda-ish.
5. **What we ran** — oracle fuzz (n, mismatches=0), standing tests, project tests. Name the oracle (`lodash@4.17.21` on disk).
6. **Envelope** — purity bullets; options we **did not** implement; grep proof we don’t call them.
7. **Residual risk** — the ways this can still be wrong. Always non-empty. For `validator.isEmail`: “not RFC-complete; oracle-bounded.” For synthesize: “new code, not a copy of lodash/get.js; bugs will look like ours, not theirs.”
8. **Upstream** — how `watch` will decide exposure (export names + compare diff).
9. **Verdict** — one of:
   - `Merge if you accept residual risk.`
   - `Do not merge.` (fuzz fail, tests fail — replace should have aborted, but keep the line for copied reports)

No marketing. No “AI generated with confidence 0.92.”

Sample: [`evidence.lodash.sample.md`](./evidence.lodash.sample.md).

---

## 9. Upstream watch (no SaaS)

Slim never phones home. Watch uses public APIs from the machine that runs it (your laptop or GitHub-hosted runner).

### How it is scheduled

There is no daemon.

1. **Default:** GitHub Action, weekly. Copy `docs/examples/slim-watch.yml` (`uses: slim-hq/slim/action/upstream@v1` after checkout, Node 22.18, and `npm ci`).
2. **Laptop:** `slim watch` whenever. cron `0 9 * * 1 slim watch` if they insist.
3. `doctor` warns if slices exist and the workflow file is missing.

```yaml
# .github/workflows/slim-watch.yml
name: slim-watch
on:
  schedule:
    - cron: "0 14 * * 1"
  workflow_dispatch:
jobs:
  watch:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22.18"
      - run: npm ci
      - uses: slim-hq/slim/action/upstream@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Local cron is documented, not installed.

### Sources (fail-closed)

1. **OSV** `POST https://api.osv.dev/v1/query` — `{ package: { name, ecosystem: "npm" }, version }` for the pinned version and, when npm reports a newer latest, that version too. Empty `vulns` is source `success`, not “not exposed” by itself.
2. **npm registry** `GET https://registry.npmjs.org/<pkg>` — latest version and published versions. Used for routine-release notes and stale/pin checks, not as a vuln DB.
3. **Oracle install** — temp-install latest/patched, else the project pin. Required before any automatic rewrite.
4. **GitHub availability** — origin + `gh`/`GITHUB_TOKEN`, only when `--pr`. Not a GHSA advisory client.

Consulted OSV/npm `sources.*.status` values: `success`, `unavailable` (HTTP/network), `timeout`, `malformed` (invalid JSON or missing fields), `stale` (latest older than pin, or pin absent from published versions). Unconsulted sources stay `success` with detail `not required`. A consulted non-success folds to `conclusion: source-unavailable`, exit 4, and never `slice not exposed.`

Live packed `slim upstream` proof for advertised sources is `SLIM_UPSTREAM_LIVE=1`. Missing or stale `externalService.osv` / `externalService.npm-registry` receipts fail `npm run qualify`; they do not vanish from `npm test`. Set `SLIM_RECEIPTS_DIR` to write those receipts (commit + tarball digest).

Live packed `slim replace` PR proof is `SLIM_PR_LIVE=1` (GitHub CLI with repo create/push/PR plus `delete_repo`, or `SLIM_PR_TRANSFER_OWNER` to transfer leftovers). Missing or stale `externalService.github` receipts fail `npm run qualify`. Unset `SLIM_PR_LIVE` still registers the live test (it returns; it does not skip off the suite).

GitHub Advisory GraphQL and OSV `querybatch` are later-scope; OSV already mirrors GHSA ids. No NVD key. No Slim servers.

### What each slice stores

Identity lives in `.slim/<pkg>/envelope.json`, `evidence.json`, and the module under `src/slim/`. There is no separate `*.meta.json` in v1.

### Decision: was my slice exposed?

For each advisory whose affected range includes the sliced version:

1. Map advisory text and affected ranges onto used symbols from the envelope.
2. **Exposed** — intersection nonempty → regenerate only with a verified oracle (exit 1 until merged if `--pr`).
3. **Not exposed** — mapped, empty intersection → print that fact, exit 0 for that pkg.
4. **Unmapped** — cannot map → write `.slim/UPSTREAM.md`, no rewrite, fail closed (exit 1). `--fail-on` is not v1.

Routine npm releases that are not advisories are notes, not security conclusions. Unmapped routine releases do not claim “not exposed.”

Regenerate PR branch: `slim/upstream`. Body = new evidence. We do **not** auto-merge.

---

## v1 vs later

v1 implements the **full core loop**: envelope, generate, fuzz, PR, standing tests, upstream track. It does not support every package.

| In v1 | Later (same CLI, wider envelopes) |
| --- | --- |
| Seven commands (`scan`, `inspect`, `replace`, `check`, `bloat`, `upstream`, `doctor`) plus `watch` alias and the exit codes above | `slim replace --all` (dangerous; not default) |
| Catalog envelopes in [`packages.md`](./packages.md) | moment locales, js-yaml tags, markdown, ajv, AES, path-to-regexp |
| Synthesize + oracle fuzz | Extract-from-upstream mode when the method file is already small |
| Call-site scanner using the **project’s** `typescript`; Slim itself has zero runtime deps | optional bundled parser |
| `src/slim` + optional `slim.json` | package.json `"slim"` key, workspaces |
| Actions: check, bloat, upstream | IDE, language besides JS/TS, axios→fetch rewriter |
| Zero production deps for Slim itself | still zero, if we can help it |

Out of scope on purpose: billing, accounts, a hosted slice registry, auto-merge, rewriting HTTP clients, top-10k corpus scoring, merged-PR pricing, enterprise licensing, PDF generation, Node 26 CI.

If a later Slim adds network, it is a different command (`slim rewire-fetch`), not `replace`.
