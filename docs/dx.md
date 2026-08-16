# Slim developer experience

Wedge: a serverless/edge engineer on a Friday. CVE in a library they use two functions of. They run `slim replace lodash`, read a slice readable in one sitting (~250 lines for get+debounce) plus an evidence report, merge before standup.

Money and billing are out of scope. There is no SaaS. Slim is a CLI plus two GitHub Actions that call that CLI.

Parser: `node:util.parseArgs`. No commander, yargs, cac, meow. Subcommands are a `switch` on `positionals[0]`. Alias `upstream` → `watch`.

---

## 1. CLI surface

### Process contract

| Stream | Default | `--json` | `--quiet` |
| --- | --- | --- | --- |
| stdout | Human report (the thing you read) | One JSON value, no logs | Same as default / JSON |
| stderr | Progress (`fuzz 400/1000`), warnings | Progress | Errors only |
| GitHub Actions | Also emit `::error file=line::` / `::notice::` on stderr when `GITHUB_ACTIONS=1` | same | errors only |

`--json` never interleaves human lines on stdout. CI greps stdout or `jq`.

TTY: color on stdout/stderr when `isatty` and `NO_COLOR` unset. Never color JSON.

Confirmations: only if stdin is a TTY and `--yes` is absent. CI is non-interactive: missing `--yes` on a destructive/PR step is not an error; `replace` writes files and skips the PR with a one-line stderr note.

### Exit codes

| Code | When |
| --- | --- |
| 0 | Success. `watch`: slice not exposed. `check`: all standing tests + envelope match. `scan`: always 0 unless usage/internal (findings are data). |
| 1 | Operational failure: tests failed, envelope drifted, slice **exposed** or **uncertain** on an advisory, replace fuzz mismatch, dirty tree blocked a commit. |
| 2 | Usage. Help was printed to stderr. |
| 3 | Refused / envelope too wide / native / network / fs. Human-readable error already on stderr. |
| 4 | Environment: Node too old, network required but failed (OSV/npm), `gh` required for `--pr` and missing, no `package.json`. |
| 5 | Bug in Slim. Message includes `slim doctor` and the issue tracker. |

SIGINT → 130. Do not invent other codes in v1.

`slim-bloat` (the Action) uses `scan --diff`. Default exit 0 even when it comments. `--fail` makes it exit 1.

### Global flags (every command)

```
-h, --help
-V, --version
    --cwd <dir>
-q, --quiet
    --verbose
    --json
```

`--help` with a command prints that command’s help and exits 0. Bare `slim` prints top-level help and exits 2 (same as git: you did not ask for a command). `slim --help` exits 0.

Top-level help lives in [`help.txt`](./help.txt). Keep that file and `src/cli.js` in lockstep; `test/help.test.js` diffs them.

### `slim scan [dir]`

Discover direct deps that look slimmable.

```
--all                 Include packages under the size floor
--min-size <bytes>    Default 5120. Accepts 5kb, 5k, 5120
--diff                Only deps added in this git diff (PR bloat)
--fail                Exit 1 if anything would rank (for slim-bloat)
--limit <n>           Default 20
```

Stdout (human): a table, then a refuse section. JSON: `{ candidates: [...], refused: [...], measuredHow: "bundler"|"unpacked"|"bundlephobia-cache" }`.

Does not network unless bundle size cannot be measured locally; then optional npm/bundlephobia, fail open (size = unpacked or unknown) rather than exit 4.

### `slim inspect <pkg>`

One package. No writes. This is the “should I?” command.

```
# no extra flags beyond global
```

Exit 0 if Slim would try. Exit 3 if it would refuse (still print the full inspect report; the code is the refuse). Exit 1 if the package is not a dependency.

JSON: envelope object plus `{ decision: "try"|"refuse", reason }`.

### `slim replace <pkg>`

The product.

```
-y, --yes               Skip TTY confirm
    --no-pr             Write files; do not commit or open a PR
    --no-commit         Write files; do not git commit (implies no PR)
    --dry-run           Print the plan; write nothing
    --fuzz-iterations <n>  Override config (default 200)
    --out <dir>         Override slices dir (default src/slim)
```

Steps, in order, stop on first failure:

1. Resolve pkg in package.json / lockfile. Missing → exit 1.
2. Refuse gates (native, network, fs, framework, envelope-too-wide) → exit 3.
3. Build envelope from call sites.
4. Generate slice + standing tests + evidence report.
5. Fuzz slice against the installed original (oracle). Mismatch → exit 1, keep no files (or write to a temp dir and print the failing input).
6. Rewrite imports/requires to the slice file.
7. Remove the package from `package.json` (and the obvious lockfile via `npm uninstall --package-lock-only` / `pnpm remove` / `yarn` if we can detect; if not, edit package.json and tell the human to reinstall).
8. Run standing tests. Run `testCommand` if set/detected.
9. Unless `--no-commit`: create branch `slim/replace-<pkg>`, commit.
10. Unless `--no-pr`: `gh pr create`. No `gh` → exit 4 after the commit exists, with the exact `gh pr create` command.

Default when TTY: after step 8, one prompt:

```
Open PR 'slim/replace-lodash'? [Y/n]
```

Default when not TTY: behave like `--yes` for the write+test, skip PR unless `--yes` (CI replace is rare; the Action is `check`/`watch`, not `replace`).

### `slim check [pkg]`

CI. No network. No generation.

```
    --update-envelope   Rewrite envelope call-site list if it grew, then fail
                        (default: fail on drift, do not rewrite)
```

For each slice (or one pkg):

1. Re-scan call sites. If a site uses an export not in the envelope → fail (exit 1).
2. Run `src/slim/<pkg>.test.js` via `node --test`.
3. Hash the slice file; compare to meta. If the human edited the slice, that’s fine — hash updates only with `--update-envelope`? **No.** Edits are allowed; check does not fail on hash mismatch. Hash is for watch/repro. Check fails on test fail and envelope drift only.
4. Optional `testCommand`.

Empty `src/slim` → exit 0 with `no slices` (so adding the Action to a repo that has not slimmed yet is free).

### `slim watch [pkg]`  (alias `slim upstream`)

```
    --pr                Open a PR if a slice is exposed or uncertain
    --write-workflow    Write .github/workflows/slim-watch.yml and exit
    --fail-on <mode>    slice-exposed (default) | any-advisory | never
```

See §9. Network: OSV, GitHub GraphQL/REST if `GITHUB_TOKEN`/`gh`, npm registry. Any source failing → warning on stderr, continue with the others; if **all** fail → exit 4.

### `slim doctor`

`--strict` makes a dirty working tree exit 4. Default: list the dirty-tree issue and still exit 0 if Node and `registerHooks` are ok. Always prints a CJS hooks recommendation for Node >= 22.22.3. Exit 4 if Node < 22.18. Warnings (gh missing, no watch workflow, dirty tree without `--strict`) do not fail doctor. `--json` dumps the report including `dirtyTree` and `issues`.

### Command help (tired human)

Each `--help` is ≤ 40 lines. Verb first. One example. No “utilize.”

`slim replace --help`:

```
slim replace — write a verified slice and (usually) open a PR

Usage:
  slim replace <pkg> [options]

  -y, --yes              Don't ask. Write, test, PR if gh is available
      --no-pr            Write files, don't open a PR
      --no-commit        Write files, don't git commit
      --dry-run          Show the envelope and plan, write nothing
      --fuzz-iterations <n>
      --out <dir>        Default: src/slim

Exit: 0 wrote (and PR opened if requested). 1 tests/fuzz failed.
      3 Slim refuses this envelope. 4 missing gh/git when PR required.

Example:
  slim replace lodash
```

---

## 2. Magical moment (Friday 16:40)

Project: a Cloudflare Worker. `lodash@4.17.21`. GHSA out for `_.template` prototype pollution. They use `_.get` and `_.debounce`. Standup is 9:30.

### `slim scan`

```
$ slim scan
slim scan  src/  wrangler.toml  package.json

  package       into bundle   used     score   next
  lodash        25.8 kB gz    get, debounce    1   slim inspect lodash
  mime-types    24.1 kB gz    lookup           2   slim inspect mime-types

  2 more under 5 kB hidden (ms, cookie). --all to show.

  fat, not slimmable:
  axios         18.1 kB gz    envelope-network   keep or switch to fetch

Measured from wrangler bundle (esbuild). Unpacked lodash on disk: 1.4 MB.
```

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

  size (est.)
    package:     71.0 kB min  →  ~1.8 kB
    this worker: 82.4 kB gz   →  ~58 kB gz   (−24 kB, −29%)
    Lambda unpacked, if you also ship this: −1.4 MB node_modules/lodash

  next:  slim replace lodash
```

### `slim replace lodash`

```
$ slim replace lodash
envelope         get, debounce
generate         src/slim/lodash.ts  (~250 lines)
oracle fuzz      200/200 match lodash@4.17.21
standing tests   12 pass
project tests    npm test  (3 pass)
imports          src/handler.ts
package.json     - lodash

  src/slim/lodash.ts
  src/slim/lodash.test.ts
  .slim/lodash/envelope.json
  .slim/lodash/evidence.md

Open PR 'slim/replace-lodash'? [Y/n] y
branch  slim/replace-lodash
pr      https://github.com/acme/edge-api/pull/842

Read .slim/lodash/evidence.md (~90s) and src/slim/lodash.ts
then merge. This is evidence, not proof.
```

### Evidence (what they actually read)

See §8. They open `.slim/lodash/evidence.md`, then the ~250-line file. The PR body is the first screen of that report plus the URL to the file. Worker-shaped golden fixture: `fixtures/lodash-get-debounce/`.

### Cold-start framing (print this, don’t overclaim)

Workers: isolate must finish **startup in 1 s**. Cloudflare warns past **1 MiB gz**; hard limit **3 MiB gz free / 10 MiB paid**. Bytes you never parse are the only honest cold-start claim until we measure.

Lambda: **bundled** (esbuild) behaves like Workers. **Unbundled** `node_modules` is unzip + V8 compile; deleting lodash is ~1.4 MB unpacked, which is the number to put on the PR if `wrangler`/`esbuild` is absent.

v1 prints:

```
cold start
  Workers:  less JS to parse on isolate start (limit 1s). We did not
            measure CPU. Bundle −24 kB gz on this worker.
  Lambda:   if unbundled, −1.4 MB unpacked lodash from the image.
```

No “50% faster p95.” If a later flag `--measure` exists, it can run `wrangler dev` / a fixture. Not required for v1.

### After merge

`slim check` is in CI. `slim watch` is a Monday cron. The CVE in `_.template` does not apply. Watch says so.

---

## 5. GitHub Actions

Two composite actions in this repo. They wrap the CLI. Users still `actions/checkout` first.

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
      - uses: slim-js/slim/action/check@v1
```

`action/check/action.yml` (ours):

```yaml
name: slim-check
description: Re-run Slim standing tests; envelope still matches call sites
inputs:
  version:
    description: npm dist-tag or exact slim version
    default: "1"
  working-directory:
    default: "."
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
      with:
        node-version: "22.18"
    - run: npx --yes slim@${{ inputs.version }} check
      shell: bash
      working-directory: ${{ inputs.working-directory }}
```

Fails the PR on envelope drift or standing-test fail. Empty `src/slim` → pass.

### `slim-bloat` (optional, PRs that add fat deps)

```yaml
name: slim-bloat
on:
  pull_request:
jobs:
  bloat:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: slim-js/slim/action/bloat@v1
```

`action/bloat/action.yml` runs `npx slim scan --diff` and, if candidates exist, comments on the PR with `gh`:

```
This PR adds lodash (71 kB min / 25.8 kB gz). Call sites look like 2 functions.
Inspect: npx slim inspect lodash
Replace: npx slim replace lodash
```

Default: comment, exit 0. Input `fail: true` → exit 1.

### Watch workflow (immune system)

Written by `slim watch --write-workflow`. See §9.

---

## 8. Evidence report (90 seconds)

File: `src/slim/<pkg>.evidence.md`

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

## 9. Upstream immune system (no SaaS)

Slim never phones home. Watch uses public APIs from the machine that runs it (your laptop or GitHub-hosted runner).

### How it is scheduled

There is no daemon.

1. **Default:** GitHub Action, weekly. `slim watch --write-workflow` writes it.
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
      - run: npx --yes slim@1 watch --pr
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Local cron is documented, not installed.

### Sources (best-effort, in this order)

1. **OSV** `POST https://api.osv.dev/v1/querybatch` — `{ package: { name, ecosystem: "npm" }, version }` per slimmed pkg. Also query without version to see later vulns.
2. **GitHub Advisory** — `gh api graphql` if `gh`/`GITHUB_TOKEN`, else skip with a notice. OSV already mirrors GHSA; this is for permalinks and `references`.
3. **npm registry** `GET https://registry.npmjs.org/<pkg>` — versions published after the sliced `version`. Used for *release* diffs, not as a vuln DB.

No NVD key. No Slim servers.

### Meta each slice stores (`*.meta.json`)

Enough to answer “was my slice exposed?”

```json
{
  "package": "lodash",
  "version": "4.17.21",
  "ecosystem": "npm",
  "generated": "synthesize",
  "exports": ["get", "debounce"],
  "upstreamRepo": "https://github.com/lodash/lodash",
  "upstreamFilesHint": ["get.js", "debounce.js", "toPath.js"],
  "slice": "lodash.js",
  "license": "MIT"
}
```

`generated: "synthesize"` means we wrote new JS and used lodash as oracle. There is no byte-for-byte file list. `upstreamFilesHint` is the mapping table for diffs (lodash’s per-method files).

### Decision: was my slice exposed?

For each new **advisory** on `name` whose affected range includes the sliced version, *or* a patched version we never took:

1. Collect **symbols** from the advisory summary + GHSA / OSV `affected.ecosystem_specific`.
2. Fetch `compare/v{sliced}...v{patched}` (or the fixing commit) from `upstreamRepo`. Parse changed paths.
3. Map paths → export names (`get.js` → `get`). Union with symbols from (1).
4. Intersect with `meta.exports`.

| Intersection | Advisory mapping | Action |
| --- | --- | --- |
| empty | mapped | Not exposed. Print “CVE-… patches `template`. You use `get`, `debounce`.” Exit 0 for that pkg. |
| nonempty | mapped | Exposed. `--pr`: regenerate against the patched version (or, if we still don’t need the patched fn, rewrite evidence + bump `version` in meta after re-fuzz). Exit 1 until merged. |
| — | cannot map (minified, “all lodash”, no repo) | **Uncertain.** Treat as exposed for `--fail-on slice-exposed`. PR body: advisory + slice file + “human must decide.” Fail closed. |

For each new **npm release** that is not an advisory:

| Diff vs used exports | Action |
| --- | --- |
| no used files/symbols | Note, exit 0 |
| used exports changed | PR to regenerate |
| cannot map | Note, exit 0 (**fail open** on routine releases) |

`--fail-on any-advisory` fails even on empty intersection (for orgs that want a human every time lodash has a GHSA). Default is `slice-exposed`.

Regenerate PR branch: `slim/upstream-lodash-CVE-2026-1234` or `slim/upstream-lodash-4.18.1`. Body = new evidence report + the intersection table.

We do **not** auto-merge.

---

## v1 vs later

v1 implements the **full core loop**: envelope, generate, fuzz, PR, standing tests, upstream track. It does not support every package.

| In v1 | Later (same CLI, wider envelopes) |
| --- | --- |
| All 6 commands + aliases + exit codes above | `slim replace --all` (dangerous; not default) |
| First-wave envelopes in [`packages.md`](./packages.md) | moment locales, js-yaml tags, markdown, ajv, AES, path-to-regexp |
| Synthesize + oracle fuzz | Extract-from-upstream mode when the method file is already small |
| Call-site scanner without TypeScript as a dependency | Use the project’s `typescript` if present |
| `src/slim` + optional `slim.json` | package.json `"slim"` key, workspaces |
| Actions: check, bloat, watch | IDE, language besides JS/TS, axios→fetch rewriter |
| Zero production deps for Slim itself | still zero, if we can help it |

Out of scope on purpose: billing, accounts, a hosted “slice registry,” auto-merge, rewriting HTTP clients.

If a later Slim adds network, it is a different command (`slim rewire-fetch`), not `replace`.
