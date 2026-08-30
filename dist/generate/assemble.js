import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { catalogRoot, guardedReadFileSync, slimRoot } from "./guard.js";
import { generatedHeader } from "./header.js";
import { loadTargetTypescript } from "../project.js";
const INTERNAL_SPEC = /(?:^|\/)_internal(?:\.\w+)?$/;
export function assembleCatalogModule(env, projectRoot = slimRoot()) {
    const ts = loadTargetTypescript(projectRoot);
    const family = env.package.family;
    const requested = env.symbols
        .map((s) => s.exportName)
        .filter((n) => n !== "*" && n !== "(scan)");
    const symbols = requested.filter((n) => n !== "default");
    const defaultOnly = symbols.length === 0 && requested.includes("default");
    if (!symbols.length && !defaultOnly)
        return null;
    const entrySymbols = defaultOnly ? ["default"] : symbols;
    const entryFiles = [];
    const ids = [];
    for (const sym of entrySymbols) {
        const found = firstCatalogFile(family, catalogLookupSymbol(family, sym));
        if (!found)
            return null;
        ids.push(`${family}.${sym}`);
        if (!entryFiles.includes(found))
            entryFiles.push(found);
    }
    const files = collectCatalogFiles(ts, entryFiles);
    const internalNames = new Set();
    for (const f of files) {
        for (const n of importedInternalNames(ts, guardedReadFileSync(f))) {
            internalNames.add(n);
        }
    }
    const parts = [];
    if (internalNames.size) {
        const internal = firstExisting(join(catalogRoot(), "_internal.ts"), join(catalogRoot(), "_internal.js"));
        if (internal) {
            const slice = treeShakeInternal(ts, guardedReadFileSync(internal), internalNames);
            if (slice)
                parts.push(slice);
        }
    }
    for (const f of files) {
        const body = stripLeadingComment(stripImports(guardedReadFileSync(f)));
        if (body)
            parts.push(body);
    }
    const assembledBody = parts.join("\n\n");
    const uniq = [...new Set(symbols.map((s) => (s === "first" ? "head" : s)))];
    let extra = "";
    if (uniq.includes("head") && !/\bexport\s+(?:const|function)\s+first\b/.test(assembledBody)) {
        extra += `\nexport const first = head;\n`;
    }
    let defaultExport = "";
    if (wantsDefaultExport(env) && !/\bexport\s+default\b/.test(assembledBody)) {
        const defaultObj = uniq
            .map((s) => (s === "head" ? "head, first: head" : s))
            .join(",\n  ");
        defaultExport = `\nexport default {\n  ${defaultObj}\n};\n`;
    }
    return generatedHeader(env, { catalogIds: ids }) + assembledBody + extra + defaultExport;
}
function wantsDefaultExport(env) {
    return env.imports.some((i) => i.kind === "default" || i.kind === "namespace");
}
function collectCatalogFiles(ts, entryFiles) {
    const ordered = [];
    const seen = new Set();
    const visit = (file) => {
        if (seen.has(file))
            return;
        seen.add(file);
        const src = guardedReadFileSync(file);
        const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        for (const stmt of sf.statements) {
            if ((ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) &&
                stmt.moduleSpecifier &&
                ts.isStringLiteral(stmt.moduleSpecifier)) {
                const spec = stmt.moduleSpecifier.text;
                if (!spec.startsWith("./") || INTERNAL_SPEC.test(spec))
                    continue;
                const resolved = firstExisting(join(dirname(file), spec), join(dirname(file), spec.replace(/\.js$/, ".ts")), join(dirname(file), `${spec}.ts`));
                if (resolved)
                    visit(resolved);
            }
        }
        ordered.push(file);
    };
    for (const f of entryFiles)
        visit(f);
    return ordered;
}
function importedInternalNames(ts, src) {
    const sf = ts.createSourceFile("catalog.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const names = [];
    for (const stmt of sf.statements) {
        if (!ts.isImportDeclaration(stmt) || !stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) {
            continue;
        }
        if (!INTERNAL_SPEC.test(stmt.moduleSpecifier.text))
            continue;
        const nb = stmt.importClause?.namedBindings;
        if (nb && ts.isNamedImports(nb)) {
            for (const el of nb.elements) {
                names.push((el.propertyName ?? el.name).text);
            }
        }
    }
    return names;
}
function treeShakeInternal(ts, src, roots) {
    const sf = ts.createSourceFile("_internal.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const byName = new Map();
    for (const stmt of sf.statements) {
        for (const n of statementNames(ts, stmt)) {
            byName.set(n, stmt);
        }
    }
    const keep = new Set();
    const queue = [...roots];
    const seen = new Set();
    while (queue.length) {
        const name = queue.pop();
        if (seen.has(name))
            continue;
        seen.add(name);
        const stmt = byName.get(name);
        if (!stmt)
            continue;
        keep.add(stmt);
        for (const ref of statementRefs(ts, stmt, byName)) {
            if (!seen.has(ref))
                queue.push(ref);
        }
    }
    const pieces = [];
    for (const stmt of sf.statements) {
        if (!keep.has(stmt))
            continue;
        pieces.push(unexport(stmt.getText(sf)));
    }
    return pieces.join("\n\n");
}
function statementNames(ts, stmt) {
    const names = [];
    if ((ts.isFunctionDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isTypeAliasDeclaration(stmt) ||
        ts.isInterfaceDeclaration(stmt)) &&
        stmt.name) {
        names.push(stmt.name.text);
    }
    if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
            if (ts.isIdentifier(d.name))
                names.push(d.name.text);
        }
    }
    return names;
}
function statementRefs(ts, stmt, declared) {
    const refs = new Set();
    const own = new Set(statementNames(ts, stmt));
    const visit = (node) => {
        if (ts.isIdentifier(node) && declared.has(node.text) && !own.has(node.text)) {
            const parent = node.parent;
            const isProp = (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) ||
                (parent && ts.isPropertyAssignment(parent) && parent.name === node) ||
                (parent && ts.isMethodDeclaration(parent) && parent.name === node);
            if (!isProp)
                refs.add(node.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(stmt);
    return refs;
}
function unexport(text) {
    return text.replace(/^export\s+default\s+/, "").replace(/^export\s+/, "");
}
function stripLeadingComment(src) {
    return src.replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/, "").trim();
}
function stripImports(src) {
    return src
        .replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
        .replace(/^export\s+\{\s*[^}]+\} from\s+["'][^"']+["'];?\s*$/gm, "")
        .trim();
}
function catalogLookupSymbol(family, symbol) {
    return family === "lodash" && symbol === "first" ? "head" : symbol;
}
function catalogFileBases(family) {
    const camel = family.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return camel === family ? [family] : [family, camel];
}
function firstCatalogFile(family, symbol) {
    const bases = catalogFileBases(family);
    for (const base of bases) {
        const per = firstExisting(join(catalogRoot(), `${base}.${symbol}.ts`), join(catalogRoot(), `${base}.${symbol}.js`));
        if (per)
            return per;
    }
    for (const base of bases) {
        const bundled = firstExisting(join(catalogRoot(), `${base}.ts`), join(catalogRoot(), `${base}.js`));
        if (bundled)
            return bundled;
    }
    return null;
}
function firstExisting(...paths) {
    return paths.find((p) => existsSync(p)) ?? null;
}
export function catalogFileFor(family, symbol) {
    return firstCatalogFile(family, catalogLookupSymbol(family, symbol)) ?? join(catalogRoot(), `${family}.${symbol}.ts`);
}
//# sourceMappingURL=assemble.js.map