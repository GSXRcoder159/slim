# Security

## Reporting

If Slim's fuzzer and standing tests missed a mismatch between a replacement and the original for an observed call shape, email the maintainers or open a private advisory. Include:

- package name@version
- envelope hash (`.slim/<pkg>/evidence.json`)
- minimized args / debounce script
- original vs slim outcomes

Do not file a public issue with an exploit against a still-installed upstream package if that would put users at risk; we already track osv.dev via `slim upstream`.

## Allowlist

Generated code is fail-closed: no `eval`, `Function`, `WebAssembly`, `import()`, `require`, `Proxy`, `fetch`, string-`setTimeout`, `Object.setPrototypeOf`, `__proto__` assignment, or `Object.defineProperty` targeting `Object.prototype` / `*.prototype`. Catalog get/set/has may use `Object.defineProperty` on a user object to set an own `__proto__` data property (hardening, not prototype mutation). `_.template` is a refuse.

Public spec reads (`.d.ts`, README) stay inside the package root or `@types/<pkg>`. Traversal, absolute metadata paths, and escaping symlinks are refused before any LLM request.

## Supply chain

`npm publish --provenance` on tags. Slim has zero runtime dependencies.
