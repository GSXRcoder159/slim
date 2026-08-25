import { parseSpecifier, resolvePackageFamily } from "../analyze/family.ts";
import type { Envelope } from "../envelope/types.ts";

/** Specifiers to rewrite: observed import sites plus the package being replaced. */
export function rewriteSpecifiers(env: Envelope, pkg: string): Set<string> {
  const specs = new Set<string>();
  specs.add(pkg);
  specs.add(env.package.name);
  for (const i of env.imports) specs.add(i.specifier);
  return specs;
}

function declaredName(dep: string): string {
  return parseSpecifier(dep)?.name ?? dep;
}

/**
 * package.json keys to remove: the replaced package, plus family siblings that
 * have at least one import site in this envelope (those sites are rewritten).
 */
export function removeDependencyNames(env: Envelope, declared: Iterable<string>): Set<string> {
  const importedNames = new Set<string>();
  for (const i of env.imports) {
    const parsed = parseSpecifier(i.specifier);
    if (parsed) importedNames.add(parsed.name);
    else importedNames.add(i.specifier);
  }
  const out = new Set<string>([env.package.name]);
  const family = env.package.family;
  for (const dep of declared) {
    const name = declaredName(dep);
    const fam = resolvePackageFamily(name);
    if (!fam || fam.family !== family) continue;
    if (name === env.package.name) {
      out.add(name);
      continue;
    }
    if (importedNames.has(name)) out.add(name);
  }
  return out;
}
