# EVIDENCE, NOT PROOF

Differential fuzzing over the inferred envelope is **strong evidence, not proof**. Slim ships the envelope as a standing regression suite. When a new call site appears, `slim check` fails and you re-run `slim replace`.

## 1. What was used

- Package: `lodash@4.17.21` (family `lodash`)
- Symbols: `get`, `debounce`
- Call sites: 6
- Unknowns: 0
- Catalog: lodash.get, lodash.debounce
- Envelope hash: `95e946ccb025a9932dda151b9d5e0e9d0d32563b942e29a757eb046ebe36187f`

## 2. Byte delta

71000 B estimated original min → 6981 B replacement


## 4. Edge

Stock lodash uses `Function(String)` and is rejected on Cloudflare/Vercel Edge. This slice does not.
The cap that bites Workers is **1s startup parse**, not gzip 3MB/10MB (those limits are in flux).


## 5. Fuzz

- cases: 635805
- comparisons: 635825
- timerCases: 10
- traces replayed: 0
- disagreements: 0
- wall: 8007 ms
- seed: 990766132

## 6. Coverage holes

- debounce options (maxWait/leading) never observed; taxonomy still run in Slim CI
- debounce.cancel never accessed at call sites

## 7. Upstream pin

Slim will watch this slice via `slim upstream` / osv.dev. Registry: https://www.npmjs.com/package/lodash

## 8. How to revert

git revert the Slim PR, or restore the dependency in package.json and delete src/slim/<pkg>.ts

## Residual risk

- Differential fuzzing over the inferred envelope is strong evidence, not proof. Unobserved call shapes can still disagree.
- No runtime traces. Generators are static-shape plus catalog mutations, not your runtime distribution.
- Timer taxonomy is sampled, not exhaustive of every interleaving.
- Upstream may patch bugs outside this slice; slim upstream watches advisories for used symbols.
