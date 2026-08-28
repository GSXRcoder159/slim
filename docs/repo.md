# Slim repo layout, config, hygiene

Single npm package. Slim’s own `package.json` has **zero** `dependencies`. License is **MIT**. Repository: `https://github.com/slim-hq/slim`.

---

## Layout

```
slim/
  package.json              # bin: slim → dist/main.js, engines.node >=22.18.0, dependencies: {}
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
    analyze/ envelope/ fuzz/ generate/ github/ rewrite/ trace/ upstream/ size/ evidence/
  test/                     # node:test, including test/catalog/ and test/github/
  fixtures/
    lodash-get-debounce/    # golden Worker-shaped replace artifact
    moment-format/ uuid-v4/ ms-parse/ nanoid-id/ clsx-join/
    whatwg-url-host/ bluebird-delay/ mime-types-lookup/
    lodash-dynamic-refuse/ native-addon-refuse/
  action/                   # check, bloat, upstream composites → action/run.mjs
  docs/                     # dx, packages, schemas, examples
  scripts/                  # build.mjs (wipe dist, tsc, catalog copy, stamp), similarity-gate, refresh-golden, measure-claims
  .github/workflows/        # ci (OS × Node matrix), release, slim-check, slim-bloat, slim-upstream
```

TypeScript compiles to `dist/` via `npm run build` (`scripts/build.mjs` runs `tsc` with `noEmitOnError`, deletes stale outputs, copies catalog `.ts` sources, writes `dist/.slim-build.json`). `"type": "module"`. `package.json` `"files"` ships `dist`, `action/`, root `slim.schema.json`, `docs/*.schema.json`, `LICENSE`, `README.md`, `CHANGELOG.md`. Tests, fixtures, and `src/` are not packed. Do not commit `dist/` or `*.tgz`.

Fixtures are mini-apps. Tests invoke `dist/main.js` or `src/main.ts` under `--experimental-strip-types`.

---

## Config

Look for `slim.json` then `slim.config.json` walking up from the project root. No `package.json#slim` in v1. No `--cwd` flag.

Allowed fields (unknown key = doctor/check warning; `replace` refuses unknown keys):

| Field | Default | Why |
| --- | --- | --- |
| `outDir` | `src/slim` | commitable slices |
| `budgetMs` | `30000` (`300000` if `CI=1`) | fuzz wall clock |
| `include` | gitignore-aware whole repo | monorepo narrowing |
| `ignore` | `[]` | generated clients |
| `testCommand` | detect `npm test` / skip | project tests after replace |
| `replacements` | `{}` | written by `replace`; `check` reads recorded slices |

```json
{
  "$schema": "https://unpkg.com/slim/slim.schema.json",
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
- **CI:** Linux, macOS, Windows × Node 22.18 and 24. Node 26 Current is not in CI until LTS.
- **Release:** tag `v*` → test, similarity, pack, `npm publish --dry-run`, sha256, then `npm publish --provenance`.
- **Actions:** published `uses: slim-hq/slim/action/check@v1` (and bloat/upstream) run only compiled `dist/github/*-action.js`. Missing or stale distributable code exits 4. This repo gitignores `dist/`; dogfood workflows `npm run build` then `uses: ./action/*`. Published tags must include the compiled Action files.

No `packages/` monorepo, no telemetry, no commander/chalk/ora, no hosted advisory proxy.
