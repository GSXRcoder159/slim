import { hashEnvelope } from "../envelope/types.js";
export function generatedHeader(env, opts) {
    const ids = opts?.catalogIds?.join(", ") || "none";
    const lines = [
        "/**",
        " * SPDX-License-Identifier: MIT",
        " * Slim generated implementation. n-gram similarity is a CI heuristic, not a legal opinion.",
        ` * Envelope ${hashEnvelope(env)}`,
        ` * Catalog ${ids}`,
        ` * Evidence: .slim/${env.package.name}/evidence.md`,
    ];
    if (opts?.promptHash) {
        lines.push(` * Prompt ${opts.promptHash}`);
    }
    lines.push(" *", " * Slim is not affiliated with the original package authors.", " * Differential fuzzing is evidence, not proof.", " */", "", "");
    return lines.join("\n");
}
/** Prepend the Slim header. Strips an existing leading block comment so it is idempotent. */
export function withGeneratedHeader(source, env, opts) {
    const header = generatedHeader(env, opts);
    let body = source.trimStart();
    if (body.startsWith("/**")) {
        body = body.replace(/^\/\*\*[\s\S]*?\*\/\s*/, "");
    }
    return header + body;
}
//# sourceMappingURL=header.js.map