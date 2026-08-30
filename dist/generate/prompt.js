import { createHash } from "node:crypto";
const SPEC_CAP = 12_000;
const EXAMPLE_CAP = 500;
const EXAMPLE_COUNT = 8;
export function capCounterexamples(examples) {
    return examples.slice(-EXAMPLE_COUNT).map((s) => (s.length > EXAMPLE_CAP ? `${s.slice(0, EXAMPLE_CAP)}…` : s));
}
export function buildPrompt(env, publicApi, counterexamples) {
    const wantsDefault = env.imports.some((i) => i.kind === "default" ||
        i.kind === "namespace" ||
        i.kind === "cjs-require" ||
        i.kind === "subpath-default");
    const harden = env.symbols.some((s) => s.hyrum.prototype || /^(get|set|has)$/.test(s.exportName));
    const system = [
        "You write a clean-room TypeScript module that implements ONLY the used exports in the envelope.",
        "Rules:",
        "- Implement from the envelope and public .d.ts/README only. Do not copy original package source.",
        "- n-gram similarity is a CI heuristic, not a legal opinion.",
        "- No eval, Function, WebAssembly, import(), require, node: builtins, fetch, Proxy, string-setTimeout.",
        "- No Object.setPrototypeOf (including aliases, computed access, and .call/.apply), __proto__ assignment, Object.assign onto a prototype, or Object.defineProperty / defineProperties on Object.prototype / *.prototype.",
        "- Look up Date.now, setTimeout, clearTimeout at call time. Never cache timers at module init.",
        "- Named exports for each used symbol.",
        wantsDefault ? "- Also `export default { ... }` covering those named exports (default/namespace/CJS import)." : "",
        harden ? "- Harden __proto__/constructor/prototype on get/set/has and when hyrum.prototype is set." : "",
        "- Evidence, not proof: implement the envelope, not the whole library.",
        "Return ONLY the TypeScript module.",
    ]
        .filter(Boolean)
        .join("\n");
    const user = [
        "Envelope JSON:",
        JSON.stringify({
            package: env.package,
            env: env.env,
            imports: env.imports.map((i) => ({
                kind: i.kind,
                names: i.names,
                specifier: i.specifier,
            })),
            symbols: env.symbols.map((s) => ({
                exportName: s.exportName,
                hyrum: s.hyrum,
                resultMembers: s.resultMembers,
                callSites: s.callSites.map((c) => ({
                    argc: c.argc,
                    argShapes: c.argShapes,
                    thisBinding: c.thisBinding,
                    resultMembers: c.resultMembers,
                    memberPath: c.memberPath,
                    spread: c.spread,
                })),
            })),
            clock: env.clock,
            cryptoRandom: env.cryptoRandom,
        }, null, 2),
        "",
        "Public API (.d.ts / README excerpt):",
        `Spec source: ${publicApi.source}`,
        publicApi.from ? `Spec from: ${publicApi.from}` : "",
        publicApi.limitation ? `LIMITATION: ${publicApi.limitation}` : "",
        publicApi.text.slice(0, SPEC_CAP),
        "",
        counterexamples.length ? "Previous disagreements to fix:" : "",
        ...capCounterexamples(counterexamples),
    ]
        .filter((line) => line !== "")
        .join("\n");
    const promptHash = createHash("sha256").update(system + "\n" + user).digest("hex");
    return { system, user, promptHash };
}
//# sourceMappingURL=prompt.js.map