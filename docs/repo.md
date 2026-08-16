# Slim repo layout, config, hygiene

Single npm package. Not a 12-package monorepo. Slim’s own `package.json` has **zero** `dependencies`. Dev-only: nothing required; `node --test` is the runner. If a fixture needs lodash, that fixture has its own `package.json`.

---

## Layout

```
slim/
  package.json                 # name: slim, bin: slim → src/cli.js, dependencies: {}
  package-lock.json
  README.md
  LICENSE                      # Apache-2.0
  NOTICE                       # Apache NOTICE + “slices keep upstream licenses”
  CHANGELOG.md
  SECURITY.md
  CODE_OF_CONDUCT.md           # Contributor Covenant 2.1
  CONTRIBUTING.md
  slim.schema.json             # published, $schema for users
  src/
    cli.js                     # parseArgs, route, --help/--version, exit codes
    help.js                    # text from docs/help.txt (or inlined, tested equal)
    config.js                  # load slim.json | slim.config.json
    cwd.js                     # walk up for package.json
    io.js                      # stdout report / stderr progress / --json
    commands/
      scan.js
      inspect.js
      replace.js
      check.js
      watch.js                 # also alias upstream
      doctor.js
    envelope.js                # call-site scan + purity + refuse
    generate.js                # dispatch per envelope
    fuzz.js                    # oracle vs original module
    evidence.js                # markdown writer
    rewrite.js                 # imports/requires → slice
    git.js                     # branch, commit, gh pr create
    refuse.js                  # named reasons + error text
    packages.js                # first-wave subsets + refuse table
    upstream.js                # OSV / GHSA / npm / compare-diff
    size.js                    # wrangler/esbuild if present, else unpacked, else cache
    generators/
      lodash.js                # lodash, lodash-es, underscore, ramda (pick/path)
      native-url.js            # whatwg-url, url-parse → global URL
      mime.js
      validator.js
      cron.js
      bluebird.js
      date-fns.js
      crypto-js.js
      moment.js
      yaml.js
      jsonwebtoken.js
      qs.js                    # qs + query-string
      async.js
      uuid.js
  test/
    help.test.js
    cli.test.js                # exit codes, stdout/stderr via child_process
    envelope.test.js
    refuse.test.js
    fuzz.test.js
    upstream.test.js
    fixtures.test.js           # runs replace/check against fixtures/
  fixtures/
    worker-lodash/             # CF-style handler, lodash.get + debounce
    worker-mime/
    worker-cryptojs/           # SHA256
    worker-whatwg-url/
    lambda-uuid/
    lambda-jwt/                # jsonwebtoken.verify HS256
    app-qs/
    app-validator/
    app-moment-format/         # format only (allowed)
    app-moment-locales/        # expect refuse
    refuse-sharp/
    refuse-axios/
    refuse-prisma/
    refuse-react/
    wide-lodash/               # _.template + _.chain → envelope-too-wide
  action/
    check/action.yml
    bloat/action.yml
  src/slim/                 # dogfood: only if Slim ever takes a fat dep. Today: empty, gitkeep
  docs/
    dx.md
    packages.md
    repo.md                    # this file
    help.txt
    evidence.lodash.sample.md
    slim.schema.json
    transcripts/               # golden CLI dumps, copied from test snapshots
  .github/
    workflows/
      ci.yml
      release.yml
      slim-watch.yml           # dogfood watch on Slim itself (no-op while 0 slices)
    ISSUE_TEMPLATE/
      bug.yml
      refuse-false-positive.yml
    PULL_REQUEST_TEMPLATE.md
    dependabot.yml
  .gitignore
```

No `packages/`, no workspaces, no TypeScript build, no bundler for the CLI. `"type": "module"`. Shebang `#!/usr/bin/env node` on `src/cli.js`.

Fixtures are **mini-apps**, not unit mocks: each has `package.json`, one or two source files, and a lockfile. `test/fixtures.test.js` runs `node src/cli.js --cwd fixtures/worker-lodash scan|inspect|replace --no-pr` and asserts exit codes + files.

---

## Slim’s own package.json (dogfood)

```json
{
  "name": "slim",
  "version": "0.1.0",
  "description": "Delete a JS/TS dependency by replacing it with a verified slice",
  "bin": { "slim": "./src/cli.js" },
  "type": "module",
  "engines": { "node": ">=20.12" },
  "files": ["src", "action", "slim.schema.json", "LICENSE", "NOTICE", "README.md"],
  "scripts": {
    "test": "node --test test/**/*.test.js",
    "slim": "node src/cli.js"
  },
  "license": "Apache-2.0",
  "repository": { "type": "git", "url": "git+https://github.com/slim-js/slim.git" },
  "dependencies": {}
}
```

If someone proposes adding `chalk`, `ora`, `commander`, `zod`, `inquirer`, or TypeScript: no. Color is a 15-line `tty` check. Spinners are stderr lines with `\r`. Schema checks are handwritten.

`files` does not include `fixtures/` or `docs/` (docs stay on GitHub). Schema ships so `"$schema"` works from npm.

---

## Config

Look for, in order, in `--cwd`: `slim.json`, `slim.config.json`. No `package.json#slim` in v1.

Zero-config is the default. A repo with only `src/slim/*.meta.json` is fully operational.

Allowed fields (and no others — unknown key = doctor/check warning, not a silent ignore in v1; `replace` refuses to run with unknown keys so we don’t typo `fuzzIteration`):

| Field | Default | Why it exists |
| --- | --- | --- |
| `outDir` | `src/slim` | Slices have to live somewhere commitable |
| `budgetMs` | `30000` (`300000` if `CI=1`) | Fuzz wall clock |
| `include` | gitignore-aware whole repo | Monorepos that only want `apps/edge/**` |
| `ignore` | `[]` | Generated clients that fake call sites |
| `testCommand` | detect `npm test` / skip | Project tests after replace |
| `replacements` | `{}` | Written by `replace`; `check` reads recorded slices |

That is the whole file. No telemetry, org, token, registry, or “model” fields.

Minimal user file, only when they need it:

```json
{
  "$schema": "https://unpkg.com/slim/slim.schema.json",
  "outDir": "src/slim",
  "budgetMs": 30000,
  "testCommand": "npm test -- --run"
}
```

Slice **identity** is not in slim.json. It is `.slim/<pkg>/envelope.json` plus the module under `src/slim/`.

---

## Open-source hygiene

### LICENSE: Apache-2.0 (CLI)

Apache-2.0 for Slim the tool: patent grant, NOTICE, corporate-friendly for a thing that writes code into your tree.

**Slices are not Apache by default.** Each `src/slim/<pkg>.LICENSE` is a copy of the upstream license (MIT for lodash, etc.). `NOTICE` in Slim’s repo says generated files in *user* repos remain under upstream terms, and synthesize-mode still attributes the oracle.

MIT for the CLI is the fallback if Apache friction shows up in npm comments. Do not dual-license in v1; pick Apache-2.0.

### CONTRIBUTING.md

- Node 20.12+.
- `npm test` (node --test).
- No new production dependencies. Argue in the PR if you think you need one.
- First-wave package work = a generator + a fixture mini-app + an inspect transcript.
- DCO not required. GitHub PR reviews are enough.
- “I want Slim to support X” → open an issue with `slim inspect` output from a real repo, not a manifesto.

### SECURITY.md

- Report vulns in **Slim** via GitHub Security Advisories (private).
- A bug in a *generated slice* is a bug in Slim’s generator: same channel, include the evidence file and the slice.
- We do not run a bounty in v1.
- `slim watch` failing closed on unmapped advisories is intentional.

### CODE_OF_CONDUCT.md

Contributor Covenant 2.1. Enforcement: GitHub maintainers. No Slack.

### CI (`.github/workflows/ci.yml`)

```yaml
on: [push, pull_request]
jobs:
  test:
    strategy:
      matrix:
        node: [20, 22]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: npm test
```

No coverage vendor. No prettier as a dep: `format` is “match the files around you.” Optional later: `biome` as a *dev* dep only if it stays out of `"dependencies"`.

`fixtures.test.js` is allowed to `npm install` inside fixtures (cached).

### Release (`.github/workflows/release.yml`)

Tags `v0.1.0` → npm publish with provenance.

```yaml
on:
  push:
    tags: ["v*"]
permissions:
  id-token: write
  contents: read
jobs:
  npm:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          registry-url: https://registry.npmjs.org
      - run: npm test
      - run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

GitHub Release notes from CHANGELOG. Action tags (`action/check@v1`) are the same git tags; users pin `@v1`.

Dependabot: weekly npm on the root (should be a quiet file because deps are empty) + github-actions.

---

## Files to create (implementation inventory)

Copy-ready specs already in `docs/`. Implementation creates the rest.

### Ship the product

| File | Notes |
| --- | --- |
| `package.json` | exact shape above |
| `src/cli.js` | parseArgs; help text must match `docs/help.txt` |
| `src/help.js` | |
| `src/config.js` | schema = `slim.schema.json` |
| `src/io.js` | stdout/stderr/`--json`/GITHUB_ACTIONS |
| `src/commands/*.js` | six commands |
| `src/envelope.js` `generate.js` `fuzz.js` `evidence.js` `rewrite.js` `git.js` `refuse.js` `packages.js` `upstream.js` `size.js` | |
| `src/generators/*.js` | one per first-wave family |
| `action/check/action.yml` | as in dx.md |
| `action/bloat/action.yml` | |
| `slim.schema.json` | copy from docs |

### Prove it

| File | Notes |
| --- | --- |
| `test/*.test.js` | exit codes, help snapshot, refuse strings |
| `fixtures/worker-lodash/**` | magical moment |
| `fixtures/worker-mime/**` `worker-cryptojs/**` `worker-whatwg-url/**` | easy deletes |
| `fixtures/lambda-uuid/**` `lambda-jwt/**` | |
| `fixtures/app-qs/**` `app-validator/**` `app-moment-format/**` | |
| `fixtures/app-moment-locales/**` | exit 3 |
| `fixtures/refuse-sharp/**` `refuse-axios/**` `refuse-prisma/**` `refuse-react/**` | exit 3 + exact stderr |
| `fixtures/wide-lodash/**` | envelope-too-wide |
| `docs/transcripts/*.txt` | golden dumps from those runs |

### Hygiene (v1 day one, not “later”)

| File | Notes |
| --- | --- |
| `LICENSE` `NOTICE` | Apache-2.0 |
| `README.md` | 30-second install + the Friday transcript |
| `CHANGELOG.md` | |
| `CONTRIBUTING.md` `SECURITY.md` `CODE_OF_CONDUCT.md` | |
| `.github/workflows/ci.yml` `release.yml` `slim-watch.yml` | |
| `.github/ISSUE_TEMPLATE/*` `PULL_REQUEST_TEMPLATE.md` `dependabot.yml` | |
| `.gitignore` | `node_modules`, fixture installs if not locked |

### Do not create

- `packages/core`, `packages/cli`, `packages/action` — one package.
- `src/telemetry.js`, billing, auth.
- `commander` / `chalk` / `ora` / `inquirer`.
- A hosted advisory proxy.

---

## README (first screen)

```
Slim deletes a JS/TS dependency by replacing it with a verified slice.

  npx slim scan
  npx slim inspect lodash
  npx slim replace lodash

You read ~90 lines and an evidence report. Evidence, not proof.
CI: slim check. Upstream CVEs: slim watch (a cron Action, not a SaaS).

Requires Node 20.12+. Zero runtime dependencies.
```

Then the Friday transcript from dx.md, then a link to `docs/packages.md` for what v1 will refuse.
