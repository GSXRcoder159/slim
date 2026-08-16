import { hashEnvelope, type Envelope } from "../envelope/types.ts";

export function generatedHeader(
  env: Envelope,
  opts?: { catalogIds?: string[]; promptHash?: string },
): string {
  const ids = opts?.catalogIds?.join(", ") || "none";
  const lines = [
    "/**",
    " * SPDX-License-Identifier: MIT",
    " * Original implementation, not derived from lodash, Underscore, or OpenJS.",
    ` * Envelope ${hashEnvelope(env)}`,
    ` * Catalog ${ids}`,
    ` * Evidence: .slim/${env.package.name}/evidence.md`,
  ];
  if (opts?.promptHash) {
    lines.push(` * Prompt ${opts.promptHash}`);
  }
  lines.push(
    " *",
    " * Slim is not affiliated with the original package authors.",
    " * Differential fuzzing is evidence, not proof.",
    " */",
    "",
    "",
  );
  return lines.join("\n");
}

/** Prepend the Slim header. Strips an existing leading block comment so it is idempotent. */
export function withGeneratedHeader(
  source: string,
  env: Envelope,
  opts?: { catalogIds?: string[]; promptHash?: string },
): string {
  const header = generatedHeader(env, opts);
  let body = source.trimStart();
  if (body.startsWith("/**")) {
    body = body.replace(/^\/\*\*[\s\S]*?\*\/\s*/, "");
  }
  return header + body;
}
