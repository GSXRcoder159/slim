# Contributing to Slim

## Clean room

Catalog implementations are written from **public documentation and observed behavior**, then checked against the original package as a CI-only oracle.

- Do not paste lodash, Underscore, moment, or any original `.js` into this repo.
- Do not copy upstream tests.
- Do not implement a slice with upstream source open in another window.
- `.d.ts` and README are API specs. Implementation files are not.

Slim CI runs an n-gram similarity gate against lodash/moment tarballs in `node_modules`.

## Tests

```bash
npm test
```

`node:test` only. No extra test frameworks.

When you add a catalog function, add `test/catalog/<name>.test.ts` that compares against the real package.

## Ponytail

Zero `dependencies`. Node stdlib first. Mark intentional ceilings with a `ponytail:` comment that names the upgrade path.

## PRs

Evidence, not proof — keep that sentence in user-facing text.
