import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogRoot } from "./guard.ts";
import { hashEnvelope, type Envelope } from "../envelope/types.ts";

const HEADER = (pkg: string, hash: string, ids: string[]) =>
  `/**
 * @license MIT
 * Original Slim implementation, not derived from lodash, Underscore, or OpenJS.
 * Envelope ${hash}
 * Catalog ${ids.join(", ") || "none"}
 * Evidence: .slim/${pkg}/evidence.md
 *
 * Slim is not affiliated with the original package authors.
 * Differential fuzzing is evidence, not proof.
 */

`;

export function assembleCatalogModule(env: Envelope): string | null {
  const family = env.package.family;
  const symbols = env.symbols
    .map((s) => s.exportName)
    .filter((n) => n !== "*" && n !== "default" && n !== "(scan)");
  if (!symbols.length) return null;
  const files: string[] = [];
  const ids: string[] = [];
  for (const sym of symbols) {
    const per = firstExisting(
      join(catalogRoot(), `${family}.${sym}.ts`),
      join(catalogRoot(), `${family}.${sym}.js`),
    );
    const bundled = firstExisting(
      join(catalogRoot(), `${family}.ts`),
      join(catalogRoot(), `${family}.js`),
    );
    const found = per ?? bundled;
    if (!found) return null;
    ids.push(`${family}.${sym}`);
    if (!files.includes(found)) files.push(found);
  }
  const needInternal = files.some((f) => readFileSync(f, "utf8").includes("_internal"));
  const parts: string[] = [];
  if (needInternal) {
    const internal = firstExisting(
      join(catalogRoot(), "_internal.ts"),
      join(catalogRoot(), "_internal.js"),
    );
    if (internal) {
      parts.push(stripImports(readFileSync(internal, "utf8")));
    }
  }
  for (const f of files) {
    parts.push(stripImports(readFileSync(f, "utf8")));
  }
  const uniq = [...new Set(symbols.map((s) => (s === "first" ? "head" : s)))];
  const defaultObj = uniq
    .map((s) => (s === "head" ? "head, first: head" : s))
    .join(",\n  ");
  const hash = hashEnvelope(env);
  let extra = "";
  if (uniq.includes("head") && !symbols.includes("first")) {
    extra += `\nexport const first = head;\n`;
  }
  return (
    HEADER(env.package.name, hash, ids) +
    parts.join("\n\n") +
    extra +
    `\nexport default {\n  ${defaultObj}\n};\n`
  );
}

function stripImports(src: string): string {
  return src
    .replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/^export\s+\{\s*[^}]+\} from\s+["'][^"']+["'];?\s*$/gm, "")
    .trim();
}

function firstExisting(...paths: string[]): string | null {
  return paths.find((p) => existsSync(p)) ?? null;
}

export function catalogFileFor(family: string, symbol: string): string {
  return join(catalogRoot(), `${family}.${symbol}.ts`);
}
