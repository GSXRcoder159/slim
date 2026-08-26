# Contributing to Slim

## Clean room

Catalog implementations are written from **public documentation and observed behavior**, then checked against the original package as a CI-only oracle.

- Do not paste lodash, Underscore, moment, or any original `.js` into this repo.
- Do not copy upstream tests.
- Do not implement a slice with upstream source open in another window.
- `.d.ts` and README are API specs. Implementation files are not.

Slim CI runs an n-gram similarity gate against pinned catalog oracles in `node_modules` (including lodash `fp/`) and checked-in `fixtures/**/src/slim` slices. Missing oracle trees fail closed. The gate is a heuristic, not a legal opinion.

## Tests

```bash
npm run build
npm test
```

`node:test` only. No extra test frameworks. `npm run build` compiles with `noEmitOnError` and deletes stale `dist/` outputs; do not commit `dist/`, `slim-*.tgz`, or package-manager stores. Pack with `--pack-destination` outside the repo.

When you add a catalog function, add `test/catalog/<name>.test.ts` that compares against the real package.

## Ponytail

Zero `dependencies`. Node stdlib first. Mark intentional ceilings with a `ponytail:` comment that names the upgrade path.

## PRs

Evidence, not proof — keep that sentence in user-facing text.

Security issues: [SECURITY.md](SECURITY.md) (email or private advisory). Similarity CI is not a reporting channel.
