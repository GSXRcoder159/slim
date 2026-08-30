# Slim repo layout, config, hygiene

Single npm package. Slim’s own `package.json` has **zero** `dependencies`. License is **MIT**. Repository: `https://github.com/GSXRcoder159/slim`.

---

## Layout

```
slim/
  package.json              # name @gsxrcoder159/slim, bin: slim → dist/main.js, engines.node >=22.18.0, dependencies: {}
  LICENSE                   # MIT
  CHANGELOG.md
  README.md
  src/
    main.ts                 # shebang CLI entry
    cli.ts                  # parseArgs, HELP (docs/help.txt must match)
    doctor.ts
    replace.ts
    scan.ts / inspect.ts / check.ts
    node-min.ts             # MIN_NODE_LABEL 22.18
    analyze/ envelope/ fuzz/ generate/ github/ release/ rewrite/ trace/ upstream/ size/ evidence/
  test/                     # node:test, including test/catalog/ and test/github/
  fixtures/
    lodash-get-debounce/    # golden Worker-shaped replace artifact
    moment-format/ uuid-v4/ ms-parse/ nanoid-id/ clsx-join/
    whatwg-url-host/ bluebird-delay/ mime-types-lookup/
    lodash-dynamic-refuse/ native-addon-refuse/
  action/                   # check, bloat, upstream composites → action/run.mjs
  docs/                     # dx, packages, schemas, examples
  scripts/                  # build.mjs, artifact-identity, similarity-gate, refresh-golden, measure-claims, qualify-receipts, emit-local-receipts, qualify-candidate, pack-qualify-bundle, qualify-handoff, release-gate
  .github/workflows/        # ci (OS × Node matrix + golden-refresh), qualify (complete receipt bundle), release, slim-check, slim-bloat, slim-upstream
```

TypeScript compiles to `dist/` via `npm run build` (`scripts/build.mjs` runs `tsc` with `noEmitOnError`, deletes stale outputs, copies catalog `.ts` sources, writes `dist/.slim-build.json`). `npm run typecheck` is `tsc --noEmit`. Two clean builds and an incremental rebuild from the same sources produce the same stamp `files`, `sha256`, and `actionSha256`. `"type": "module"`. `package.json` `"files"` ships `dist`, `action/`, root `slim.schema.json`, `docs/*.schema.json`, `docs/support-inventory.json`, `docs/measurements.json`, `docs/README.md`, `LICENSE`, `README.md`, `CHANGELOG.md`. Tests, fixtures, and `src/` are not packed. Do not commit `dist/` or `*.tgz`. Pack with `--pack-destination` outside the repo. `npm run artifacts` prints one `docs/artifact-identity.schema.json` document (`commit`, `npmDigest`, `actionDigest`, `distSha256`).

Fixtures are mini-apps. Tests invoke `dist/main.js` or `src/main.ts` under `--experimental-strip-types`. The golden Worker fixture is `fixtures/lodash-get-debounce/`. Declared refresh inputs live in `.slim/refresh-inputs.json` (seed, workers, budget, lodash version, Node 22.18, linux, lockfile sha256, envelope/module/standing/hardening/fixtureRevision). `npm run refresh:golden` rewrites that fixture with `--template-only --seed 1 --workers 1 --budget-ms 30000`. `npm run refresh:golden -- --check` refreshes twice in temp dirs, requires equivalent artifacts, and checks identity fields against the committed fixture. `npm run measure:claims` rewrites `docs/measurements.json`; `npm run measure:claims -- --check` fails on stale bytes/gzip/sha256 or a date older than 7 days. CI `golden-refresh` runs both `--check` commands on ubuntu Node 22.18. `npm test` includes docs-contract and measurement gates.

---

## Config

Look for `slim.json` then `slim.config.json` walking up from the project root. No `package.json#slim` in v1. No `--cwd` flag.

Allowed fields (unknown key = doctor/check warning; `replace` refuses unknown keys):

| Field | Default | Why |
| --- | --- | --- |
| `outDir` | `src/slim` | commitable slices |
| `budgetMs` | `30000` (`300000` if `CI=1`) | extra-case quota; independent 5s case stall |
| `include` | gitignore-aware whole repo | monorepo narrowing |
| `ignore` | `[]` | generated clients |
| `testCommand` | detect `npm test` / skip | project tests after replace |
| `replacements` | `{}` | written by `replace`; `check` reads recorded slices |

```json
{
  "$schema": "https://unpkg.com/@gsxrcoder159/slim/slim.schema.json",
  "outDir": "src/slim",
  "budgetMs": 30000,
  "testCommand": "npm test -- --run"
}
```

Slice identity is `.slim/<pkg>/envelope.json` plus the module under `src/slim/`.

---

## Open-source hygiene

- **LICENSE:** MIT for the CLI. Generated slices are SPDX MIT. Do not copy upstream LICENSE files into user trees. n-gram similarity is a CI heuristic, not a legal opinion.
- **CONTRIBUTING / SECURITY / CODE_OF_CONDUCT:** as in those files. Report Slim bugs privately; a slice mismatch is a Slim bug.
- **CI:** Linux, macOS, Windows × Node 22.18 and 24, plus a required `golden-refresh` job (`refresh:golden -- --check` then `measure:claims -- --check` on ubuntu Node 22.18) and a `receipts` job that fail-closes unless all six `osNode` receipts uploaded, then packs once and uploads a seed `qualification-bundle` (tarball + `artifact-identity.json` + osNode receipts only). Each matrix cell packs once and runs `emit-local-receipts --only osNode` after tests. Node 26 Current is not in CI until LTS.
- **Qualification:** `npm run qualify:emit` writes gitignored local receipts under `qualification/receipts/` for the candidate commit and packed content digest and prints failed `checkId` output on stderr. Fixture identity is the `checkId` (local) or the documented live fixture name. Receipts older than 7 days, unknown fixtures, and omitted npm/Action digests fail closed. Live receipts require `workflowRun`. `npm run qualify:candidate` asserts a clean tree, version/tag/changelog identity, CHANGELOG revert/migration guidance, packs once, emits locals, runs live tests when `SLIM_*_LIVE=1`, then fail-closes through `qualifyInventory`. `--mode collect` merges CI `os-node-receipts` artifacts and still requires the npm digest; collect without `--os-node-only` also requires `--workflow-run`. `npm run qualify:handoff` prints one `docs/qualify-report.schema.json` document and writes gitignored `qualification/qualify-report.json`. `npm run qualify:bundle -- --from-bundle <ci-bundle>` reuses that CI tarball. Live receipts share the successful `ci.yml` run id, not the qualify job id. `.github/workflows/qualify.yml` (`workflow_dispatch` on `main` only) downloads the CI seed bundle, verifies packed identity, emits locals, runs live gates, fail-closes through the full inventory, and uploads the complete `qualification-bundle`. Receipts stay gitignored because they bind a SHA.
- **Release:** npm name is `@gsxrcoder159/slim`. Tag `vX.Y.Z` must equal `package.json` and the first CHANGELOG `##` heading. Occupied name/version on the registry is refused. The release workflow downloads `qualification-bundle` from an identified successful `qualify.yml` run and does not build or pack. It does not fall back to the incomplete CI seed bundle. Identity, occupancy, commit binding, and receipts are checked against that tarball. `--workflow-run` is the CI run id from `qualify-report.json`. Dry-run (with provenance on Actions), attach tags locally, `npm publish` that tarball, then push `vX.Y.Z` plus the advertised Action pin (`v1` during 0.x). Failure before confirmed publish restores local tags. Failure after npm publish does not unpublish; retry is tag push only (`rollback=tags-not-pushed`). `workflow_dispatch` rehearses by default; publish from dispatch is allowed only on `main`. An absent or stale bundle fails before tag or registry mutation.
- **Actions:** published `uses: GSXRcoder159/slim/action/check@v1` (and bloat/upstream) run only compiled `dist/github/*-action.js`. Missing or stale distributable code exits 4. This repo gitignores `dist/`; dogfood workflows `npm run build` then `uses: ./action/*`. Published tags must include the compiled Action files.

No `packages/` monorepo, no telemetry, no commander/chalk/ora, no hosted advisory proxy.
