import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type ts from "typescript";
import type { ImportKind, ImportSite } from "../envelope/types.ts";
import { parseSpecifier, resolvePackageFamily } from "./family.ts";
import type { Binding, CollectExtra, LocalPending, PkgLink } from "./model.ts";
import { locOf, normPath } from "./model.ts";

export function wantedSpecifiers(pkg: string): Set<string> | null {
  const fam = resolvePackageFamily(pkg);
  if (!fam) return new Set([pkg]);
  const set = new Set<string>([pkg, fam.name, fam.family]);
  if (fam.family === "lodash") {
    set.add("lodash");
    set.add("lodash-es");
    set.add("underscore");
  }
  return set;
}

export function specifierMatches(specifier: string, wanted: Set<string> | null): boolean {
  if (!wanted) return true;
  const fam = resolvePackageFamily(specifier);
  if (!fam) return wanted.has(specifier);
  if (wanted.has(specifier) || wanted.has(fam.name) || wanted.has(fam.family)) return true;
  if (fam.family === "lodash" && [...wanted].some((w) => resolvePackageFamily(w)?.family === "lodash")) {
    return true;
  }
  return false;
}

export function collectImports(
  ts: typeof import("typescript"),
  sf: ts.SourceFile,
  bindings: Binding[],
  imports: ImportSite[],
  wanted: Set<string> | null,
  extra: CollectExtra,
): void {
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause?.isTypeOnly) {
        extra.typeOnly.push({ loc: locOf(sf, node, extra.root), specifier, kind: "named", names: [] });
      } else {
        const names: string[] = [];
        const pendingNames: Array<{ local: string; imported: string }> = [];
        let kind: ImportKind = "side-effect";
        let namespaceLocal: string | undefined;
        let defaultLocal: string | undefined;
        let sawTypeOnly = false;
        if (!clause) {
          kind = "side-effect";
        } else {
          if (clause.name) {
            kind = "default";
            names.push("default");
            defaultLocal = clause.name.text;
            pendingNames.push({ local: clause.name.text, imported: "default" });
            pushPkgBinding(bindings, sf, node, specifier, clause.name.text, "default", "default", extra);
          }
          if (clause.namedBindings) {
            if (ts.isNamespaceImport(clause.namedBindings)) {
              kind = "namespace";
              names.push("*");
              namespaceLocal = clause.namedBindings.name.text;
              pushPkgBinding(bindings, sf, node, specifier, namespaceLocal, "*", "namespace", extra);
            } else if (ts.isNamedImports(clause.namedBindings)) {
              kind = "named";
              const map = new Map<string, string>();
              for (const el of clause.namedBindings.elements) {
                if (el.isTypeOnly) {
                  sawTypeOnly = true;
                  continue;
                }
                const imported = (el.propertyName ?? el.name).text;
                names.push(imported);
                pendingNames.push({ local: el.name.text, imported });
                map.set(imported, imported);
                pushPkgBinding(bindings, sf, node, specifier, el.name.text, imported, "named", extra);
              }
              if (map.size && !specifier.startsWith(".") && !specifier.startsWith("#") && parseSpecifier(specifier)) {
                extra.pkgLinks.push({ file: normPath(sf.fileName), specifier, names: map });
              }
            }
          }
        }
        if (sawTypeOnly) {
          extra.typeOnly.push({ loc: locOf(sf, node, extra.root), specifier, kind: "named", names: [] });
        }
        if (names.length || !clause) {
          if (specifierMatches(specifier, wanted)) {
            imports.push({ loc: locOf(sf, node, extra.root), specifier, kind, names });
          }
          if (namespaceLocal && parseSpecifier(specifier) && !specifier.startsWith(".")) {
            extra.pkgLinks.push({ file: normPath(sf.fileName), specifier, names: "*" });
          }
          if (defaultLocal && parseSpecifier(specifier) && !specifier.startsWith(".")) {
            extra.pkgLinks.push({
              file: normPath(sf.fileName),
              specifier,
              names: new Map([["default", "default"]]),
            });
          }
          queueLocalOrAlias(ts, sf, node, specifier, pendingNames, namespaceLocal, defaultLocal, extra);
        }
      }
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (node.isTypeOnly) {
        extra.typeOnly.push({ loc: locOf(sf, node, extra.root), specifier, kind: "named", names: [] });
      } else {
        const names: string[] = [];
        let sawTypeOnly = false;
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          const map = new Map<string, string>();
          for (const el of node.exportClause.elements) {
            if (el.isTypeOnly) {
              sawTypeOnly = true;
              continue;
            }
            const orig = (el.propertyName ?? el.name).text;
            names.push(orig);
            map.set(el.name.text, orig);
          }
          if (sawTypeOnly) {
            extra.typeOnly.push({ loc: locOf(sf, node, extra.root), specifier, kind: "named", names: [] });
          }
          if (map.size) {
            if (specifier.startsWith(".")) extra.localHops.push({ file: normPath(sf.fileName), specifier });
            else extra.pkgLinks.push({ file: normPath(sf.fileName), specifier, names: map });
          }
        } else if (!node.exportClause) {
          if (specifier.startsWith(".")) extra.localHops.push({ file: normPath(sf.fileName), specifier });
          else extra.pkgLinks.push({ file: normPath(sf.fileName), specifier, names: "*" });
        }
        if ((names.length || !node.exportClause) && specifierMatches(specifier, wanted)) {
          imports.push({
            loc: locOf(sf, node, extra.root),
            specifier,
            kind: node.exportClause ? "named" : "namespace",
            names: names.length ? names : ["*"],
          });
        }
      }
    }

    if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (ts.isExternalModuleReference(ref) && ref.expression && ts.isStringLiteral(ref.expression)) {
        const specifier = ref.expression.text;
        if (node.isTypeOnly) {
          extra.typeOnly.push({ loc: locOf(sf, node, extra.root), specifier, kind: "cjs-require", names: [] });
        } else if (specifierMatches(specifier, wanted)) {
          imports.push({
            loc: locOf(sf, node, extra.root),
            specifier,
            kind: "cjs-require",
            names: ["default"],
          });
          bindings.push({
            local: node.name.text,
            imported: "default",
            specifier,
            kind: "cjs-require",
            loc: locOf(sf, node, extra.root),
          });
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const cal = node.expression;
      if (
        ts.isIdentifier(cal) &&
        cal.text === "require" &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const specifier = node.arguments[0].text;
        const parent = node.parent;
        if (specifierMatches(specifier, wanted)) {
          imports.push({
            loc: locOf(sf, node, extra.root),
            specifier,
            kind: "cjs-require",
            names: ["default"],
          });
        }
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
          bindings.push({
            local: parent.name.text,
            imported: "default",
            specifier,
            kind: "cjs-require",
            loc: locOf(sf, node, extra.root),
          });
        } else if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
          const map = new Map<string, string>();
          for (const el of parent.name.elements) {
            if (!ts.isIdentifier(el.name)) continue;
            const imported =
              el.propertyName && ts.isIdentifier(el.propertyName)
                ? el.propertyName.text
                : el.name.text;
            map.set(imported, imported);
            bindings.push({
              local: el.name.text,
              imported,
              specifier,
              kind: "cjs-require",
              loc: locOf(sf, node, extra.root),
            });
          }
          extra.pkgLinks.push({ file: normPath(sf.fileName), specifier, names: map });
        }
        if (parseSpecifier(specifier)) {
          extra.pkgLinks.push({ file: normPath(sf.fileName), specifier, names: "*" });
        }
      }
      if (cal.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) {
        const arg = node.arguments[0];
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
          const specifier = arg.text;
          if (specifierMatches(specifier, wanted)) {
            imports.push({
              loc: locOf(sf, node, extra.root),
              specifier,
              kind: "default",
              names: ["default"],
            });
          }
          const local = localFromImportCall(ts, node);
          if (local) {
            bindings.push({
              local,
              imported: "*",
              specifier,
              kind: "default",
              loc: locOf(sf, node, extra.root),
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function pushPkgBinding(
  bindings: Binding[],
  sf: ts.SourceFile,
  node: ts.Node,
  specifier: string,
  local: string,
  imported: string,
  kind: ImportKind,
  extra: CollectExtra,
): void {
  if (specifier.startsWith(".") || specifier.startsWith("#")) return;
  if (!parseSpecifier(specifier)) return;
  bindings.push({ local, imported, specifier, kind, loc: locOf(sf, node, extra.root) });
}

function queueLocalOrAlias(
  ts: typeof import("typescript"),
  sf: ts.SourceFile,
  node: ts.Node,
  specifier: string,
  names: Array<{ local: string; imported: string }>,
  namespaceLocal: string | undefined,
  defaultLocal: string | undefined,
  extra: CollectExtra,
): void {
  let resolved: string | null = null;
  if (specifier.startsWith(".")) {
    resolved = resolveRelative(sf.fileName, specifier);
  } else if (extra.programCtx) {
    const r = ts.resolveModuleName(
      specifier,
      sf.fileName,
      extra.programCtx.options,
      extra.programCtx.host,
    );
    const file = r.resolvedModule?.resolvedFileName;
    if (file && !file.includes("node_modules")) resolved = file;
  }
  if (!resolved) return;
  extra.localPending.push({
    loc: locOf(sf, node, extra.root),
    consumerFile: sf.fileName,
    resolvedFile: normPath(resolved),
    names,
    namespaceLocal,
    defaultLocal,
  });
}

export function bindLocalReexports(bindings: Binding[], extra: CollectExtra): void {
  // ponytail: one hop only — nested barrels stay as local modules
  for (const pending of extra.localPending) {
    applyPkgLinks(pending, pending.resolvedFile, extra, bindings, 0);
  }
}

function applyPkgLinks(
  pending: LocalPending,
  file: string,
  extra: CollectExtra,
  bindings: Binding[],
  hop: number,
): void {
  const nf = normPath(file);
  for (const link of extra.pkgLinks) {
    if (normPath(link.file) !== nf) continue;
    addBindingsFromLink(pending, link, bindings);
  }
  if (hop >= 1) return;
  for (const hopSpec of extra.localHops) {
    if (normPath(hopSpec.file) !== nf) continue;
    const next = resolveRelative(hopSpec.file, hopSpec.specifier);
    if (next) applyPkgLinks(pending, next, extra, bindings, hop + 1);
  }
}

function addBindingsFromLink(pending: LocalPending, link: PkgLink, bindings: Binding[]): void {
  if (link.names === "*") {
    if (pending.namespaceLocal) {
      bindings.push({
        local: pending.namespaceLocal,
        imported: "*",
        specifier: link.specifier,
        kind: "namespace",
        loc: pending.loc,
      });
    }
    if (pending.defaultLocal) {
      bindings.push({
        local: pending.defaultLocal,
        imported: "default",
        specifier: link.specifier,
        kind: "default",
        loc: pending.loc,
      });
    }
    for (const n of pending.names) {
      if (n.imported === "default") continue;
      bindings.push({
        local: n.local,
        imported: n.imported,
        specifier: link.specifier,
        kind: "named",
        loc: pending.loc,
      });
    }
    return;
  }
  for (const n of pending.names) {
    const orig = link.names.get(n.imported);
    if (!orig) continue;
    bindings.push({
      local: n.local,
      imported: orig,
      specifier: link.specifier,
      kind: "named",
      loc: pending.loc,
    });
  }
  if (pending.namespaceLocal) {
    bindings.push({
      local: pending.namespaceLocal,
      imported: "*",
      specifier: link.specifier,
      kind: "namespace",
      loc: pending.loc,
    });
  }
}

export function localFromImportCall(
  ts: typeof import("typescript"),
  node: ts.CallExpression | ts.NewExpression,
): string | null {
  let p: ts.Node = node.parent;
  if (ts.isAwaitExpression(p)) p = p.parent;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  return null;
}

function resolveRelative(fromFile: string, spec: string): string | null {
  const dir = dirname(fromFile);
  const base = join(dir, spec);
  const candidates = [
    base,
    base + ".ts",
    base + ".js",
    base + ".tsx",
    base + ".mjs",
    base + ".cjs",
    join(base, "index.ts"),
    join(base, "index.js"),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}
