# Security

## Reporting

If Slim's fuzzer and standing tests missed a mismatch between a replacement and the original for an observed call shape, email the maintainers or open a private advisory. Include:

- package name@version
- envelope hash (`.slim/<pkg>/evidence.json`)
- minimized args / debounce script
- original vs slim outcomes

Do not file a public issue with an exploit against a still-installed upstream package if that would put users at risk; we already track osv.dev via `slim upstream`.

## Allowlist

Generated code is fail-closed: no `eval`, `Function`, `WebAssembly`, `import()`, `require`, `Proxy`, `fetch`, or string-`setTimeout`. `_.template` is a refuse.

## Supply chain

`npm publish --provenance` on tags. Slim has zero runtime dependencies.
