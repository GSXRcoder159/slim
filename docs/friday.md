# Friday walkthrough

You ship a Worker. `lodash` is in `package.json` because two call sites were convenient in 2019. A CVE drops. Tree-shaking does not remove `Function(String)`. Edge rejects the bundle.

```bash
slim doctor
slim scan
slim inspect lodash
slim replace lodash --no-pr   # skip gh if you want to read the diff first
```

Read, in order:

1. `src/slim/lodash.ts` — is this the slice you meant?
2. `.slim/lodash/evidence.md` — line 1 is **EVIDENCE, NOT PROOF**
3. The standing test file — frozen pairs, no `lodash` import
4. `git diff` — import specifiers moved; other formatting untouched

Then `slim check` in CI so a new `_.merge` cannot sneak in without a new envelope.

Revert: `git revert` the PR, or restore the dependency and delete `src/slim/`.
