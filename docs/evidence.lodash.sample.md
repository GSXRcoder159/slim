# EVIDENCE, NOT PROOF

Differential fuzzing over the inferred envelope is **strong evidence, not proof**. Slim ships the envelope as a standing regression suite. When a new call site appears, `slim check` fails and you re-run `slim replace`.

## 1. Evidence, not proof

Differential fuzzing over the inferred envelope is strong evidence, not proof.

## 2. What was used

- Package: `lodash@4.17.21` (family `lodash`)
- Symbols: `get`, `debounce`
- Call sites: 6
- Unknowns: 0
- Catalog: lodash.get, lodash.debounce
- Envelope hash: `217c102e5c34a74ba017061f1a5574a2ada6cd6a6497e6797e6eb97eafa706c4`
- Evidence hash: `0000000000000000000000000000000000000000000000000000000000000000`
- Module digest: `1111111111111111111111111111111111111111111111111111111111111111`

## 3. Byte delta

71000 B estimated original min → 6981 B replacement

## 4. Edge

Stock lodash uses `Function(String)` and is rejected on Cloudflare/Vercel Edge. This slice does not.
Cloudflare isolate CPU is a vendor startup budget. Slim does not publish a measured Worker cold-start number.

## 5. Fuzz

- cases: 1771205
- comparisons: 1771225
- timerCases: 10
- traces replayed: 12
- disagreements: 0
- wall: 30005 ms
- seed: 141647386

## 6. Coverage holes

- debounce options (maxWait/leading) never observed; taxonomy still run in Slim CI
- debounce.cancel never accessed at call sites

## 7. Upstream pin

Slim will watch this slice via `slim upstream` / osv.dev. Registry: https://www.npmjs.com/package/lodash

## 8. How to revert

1. Restore `lodash@4.17.21` in package.json.
2. Delete `src/slim/lodash.ts` and `src/slim/lodash.test.ts`.
3. Restore import specifiers in: src/index.ts
4. Run `npm install`.
Or: git revert the Slim PR.

## Residual risk

- Differential fuzzing over the inferred envelope is strong evidence, not proof. Unobserved call shapes can still disagree.
- Timer taxonomy is sampled, not exhaustive of every interleaving.
- Upstream may patch bugs outside this slice; slim upstream watches advisories for used symbols.
