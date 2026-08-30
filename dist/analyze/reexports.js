import { parseSpecifier, resolvePackageFamily } from "./family.js";
import { locOf, normPath, resolveRelative } from "./model.js";
export function wantedSpecifiers(pkg) {
    const fam = resolvePackageFamily(pkg);
    if (!fam)
        return new Set([pkg]);
    const set = new Set([pkg, fam.name, fam.family]);
    if (fam.family === "lodash") {
        set.add("lodash");
        set.add("lodash-es");
        set.add("underscore");
    }
    return set;
}
export function specifierMatches(specifier, wanted) {
    if (!wanted)
        return true;
    const fam = resolvePackageFamily(specifier);
    if (!fam)
        return wanted.has(specifier);
    if (wanted.has(specifier) || wanted.has(fam.name) || wanted.has(fam.family))
        return true;
    if (fam.family === "lodash" && [...wanted].some((w) => resolvePackageFamily(w)?.family === "lodash")) {
        return true;
    }
    return false;
}
export function collectImports(ts, sf, bindings, imports, wanted, extra) {
    const visit = (node) => {
        if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            const specifier = node.moduleSpecifier.text;
            const clause = node.importClause;
            if (clause?.isTypeOnly) {
                extra.typeOnly.push({ loc: locOf(sf, node, extra.root), specifier, kind: "named", names: [] });
            }
            else {
                const names = [];
                const pendingNames = [];
                let kind = "side-effect";
                let namespaceLocal;
                let defaultLocal;
                let sawTypeOnly = false;
                if (!clause) {
                    kind = "side-effect";
                }
                else {
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
                        }
                        else if (ts.isNamedImports(clause.namedBindings)) {
                            kind = "named";
                            const map = new Map();
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
            }
            else {
                const names = [];
                let sawTypeOnly = false;
                if (node.exportClause && ts.isNamedExports(node.exportClause)) {
                    const map = new Map();
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
                        if (specifier.startsWith("."))
                            extra.localHops.push({ file: normPath(sf.fileName), specifier });
                        else
                            extra.pkgLinks.push({ file: normPath(sf.fileName), specifier, names: map });
                    }
                }
                else if (!node.exportClause) {
                    if (specifier.startsWith("."))
                        extra.localHops.push({ file: normPath(sf.fileName), specifier });
                    else
                        extra.pkgLinks.push({ file: normPath(sf.fileName), specifier, names: "*" });
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
                }
                else if (specifierMatches(specifier, wanted)) {
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
            if (ts.isIdentifier(cal) &&
                cal.text === "require" &&
                node.arguments[0] &&
                ts.isStringLiteral(node.arguments[0])) {
                const specifier = node.arguments[0].text;
                const parent = node.parent;
                const pendingNames = [];
                let defaultLocal;
                if (specifierMatches(specifier, wanted)) {
                    imports.push({
                        loc: locOf(sf, node, extra.root),
                        specifier,
                        kind: "cjs-require",
                        names: ["default"],
                    });
                }
                if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
                    defaultLocal = parent.name.text;
                    if (parseSpecifier(specifier)) {
                        bindings.push({
                            local: parent.name.text,
                            imported: "default",
                            specifier,
                            kind: "cjs-require",
                            loc: locOf(sf, node, extra.root),
                        });
                    }
                }
                else if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
                    const map = new Map();
                    for (const el of parent.name.elements) {
                        if (!ts.isIdentifier(el.name))
                            continue;
                        const imported = el.propertyName && ts.isIdentifier(el.propertyName)
                            ? el.propertyName.text
                            : el.name.text;
                        map.set(imported, imported);
                        pendingNames.push({ local: el.name.text, imported });
                        if (parseSpecifier(specifier)) {
                            bindings.push({
                                local: el.name.text,
                                imported,
                                specifier,
                                kind: "cjs-require",
                                loc: locOf(sf, node, extra.root),
                            });
                        }
                    }
                    if (map.size && parseSpecifier(specifier)) {
                        extra.pkgLinks.push({ file: normPath(sf.fileName), specifier, names: map });
                    }
                }
                if (isCjsExportAssign(ts, node)) {
                    if (specifier.startsWith("."))
                        extra.localHops.push({ file: normPath(sf.fileName), specifier });
                    else if (parseSpecifier(specifier)) {
                        extra.pkgLinks.push({ file: normPath(sf.fileName), specifier, names: "*" });
                    }
                }
                if (specifier.startsWith(".") && (pendingNames.length || defaultLocal)) {
                    queueLocalOrAlias(ts, sf, node, specifier, pendingNames, undefined, defaultLocal, extra);
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
function pushPkgBinding(bindings, sf, node, specifier, local, imported, kind, extra) {
    if (specifier.startsWith(".") || specifier.startsWith("#"))
        return;
    if (!parseSpecifier(specifier))
        return;
    bindings.push({ local, imported, specifier, kind, loc: locOf(sf, node, extra.root) });
}
function queueLocalOrAlias(ts, sf, node, specifier, names, namespaceLocal, defaultLocal, extra) {
    let resolved = null;
    if (specifier.startsWith(".")) {
        resolved = resolveRelative(sf.fileName, specifier);
    }
    else if (extra.programCtx) {
        const r = ts.resolveModuleName(specifier, sf.fileName, extra.programCtx.options, extra.programCtx.host);
        const file = r.resolvedModule?.resolvedFileName;
        if (file && !file.includes("node_modules"))
            resolved = file;
    }
    if (!resolved)
        return;
    extra.localPending.push({
        loc: locOf(sf, node, extra.root),
        consumerFile: sf.fileName,
        resolvedFile: normPath(resolved),
        names,
        namespaceLocal,
        defaultLocal,
    });
}
export function localFromImportCall(ts, node) {
    let p = node.parent;
    if (ts.isAwaitExpression(p))
        p = p.parent;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name))
        return p.name.text;
    return null;
}
function isCjsExportAssign(ts, node) {
    const parent = node.parent;
    if (!parent ||
        !ts.isBinaryExpression(parent) ||
        parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
        parent.right !== node) {
        return false;
    }
    const left = parent.left;
    if (!ts.isPropertyAccessExpression(left) || !ts.isIdentifier(left.name))
        return false;
    if (ts.isIdentifier(left.expression) && left.expression.text === "exports")
        return true;
    if (ts.isIdentifier(left.expression) &&
        left.expression.text === "module" &&
        left.name.text === "exports") {
        return true;
    }
    if (ts.isPropertyAccessExpression(left.expression) &&
        ts.isIdentifier(left.expression.expression) &&
        left.expression.expression.text === "module" &&
        ts.isIdentifier(left.expression.name) &&
        left.expression.name.text === "exports") {
        return true;
    }
    return false;
}
//# sourceMappingURL=reexports.js.map