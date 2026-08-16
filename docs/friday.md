# Friday walkthrough

You ship a Worker. `lodash` is in `package.json` because two call sites were convenient in 2019. A CVE drops. Tree-shaking does not remove `Function(String)`. Edge rejects the bundle.

Golden Worker-shaped fixture: `fixtures/lodash-get-debounce/` (`wrangler.toml`, `src/worker.ts`). Same `get` + `debounce` slice (~250 lines) you merge on a real repo.

```bash
slim doctor
slim scan
slim inspect lodash
slim replace lodash --no-pr --no-install   # skip gh / lockfile refresh to read the diff first
```

Read, in order:

1. `src/slim/lodash.ts` — ~250 lines for `get` + `debounce`; is this the slice you meant?
2. `.slim/lodash/evidence.md` — line 1 is **EVIDENCE, NOT PROOF** (differential fuzzing is strong evidence, not proof)
3. The standing test file — frozen pairs, no `lodash` import
4. `git diff` — import specifiers moved; other formatting untouched

Then `slim check` in CI so a new `_.merge` cannot sneak in without a new envelope.

Revert: `git revert` the PR, or restore the dependency and delete `src/slim/`.
