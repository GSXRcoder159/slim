const IGNORED = new Set(["*", "(scan)"]);
const DEFAULT_KINDS = ["default", "namespace", "cjs-require", "subpath-default"];
export function checkContracts(ts, source, envelope) {
    const sf = ts.createSourceFile("slim-generated.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const named = new Set();
    let hasDefault = false;
    const defaultKeys = new Set();
    const valueProps = new Set();
    const visit = (node) => {
        collectExports(ts, node, named, () => {
            hasDefault = true;
        }, defaultKeys);
        collectValueProps(ts, node, valueProps);
        ts.forEachChild(node, visit);
    };
    visit(sf);
    const errors = [];
    const required = envelope.symbols
        .map((s) => s.exportName)
        .filter((n) => !IGNORED.has(n) && n !== "default");
    for (const name of required) {
        if (!named.has(name))
            errors.push(`missing named export ${name}`);
    }
    if (envelope.symbols.some((s) => s.exportName === "default") && !hasDefault) {
        errors.push("missing default export");
    }
    const wantsDefault = envelope.imports.some((i) => DEFAULT_KINDS.includes(i.kind));
    if (wantsDefault && !hasDefault) {
        errors.push("missing default export");
    }
    if (wantsDefault && hasDefault && defaultKeys.size) {
        for (const name of required) {
            if (!defaultKeys.has(name)) {
                errors.push(`default export missing key ${name}`);
            }
        }
    }
    const members = new Set();
    for (const s of envelope.symbols) {
        for (const m of s.resultMembers)
            members.add(m);
        for (const c of s.callSites) {
            for (const m of c.resultMembers)
                members.add(m);
        }
    }
    for (const m of members) {
        if (!valueProps.has(m))
            errors.push(`missing result member ${m}`);
    }
    return { ok: errors.length === 0, errors };
}
function collectExports(ts, node, named, onDefault, defaultKeys) {
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
        onDefault();
        addObjectKeys(ts, node.expression, defaultKeys);
        return;
    }
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) {
        const mods = node.modifiers;
        if (!mods)
            return;
        if (mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) && node.name) {
            named.add(node.name.text);
        }
        if (mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))
            onDefault();
        return;
    }
    if (ts.isVariableStatement(node)) {
        if (!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
            return;
        for (const d of node.declarationList.declarations) {
            if (ts.isIdentifier(d.name))
                named.add(d.name.text);
        }
        return;
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
            named.add(el.name.text);
            if (el.name.text === "default" || el.propertyName?.text === "default")
                onDefault();
        }
    }
}
function addObjectKeys(ts, expr, keys) {
    if (!ts.isObjectLiteralExpression(expr))
        return;
    for (const p of expr.properties) {
        if (ts.isShorthandPropertyAssignment(p))
            keys.add(p.name.text);
        else if (ts.isPropertyAssignment(p) ||
            ts.isMethodDeclaration(p) ||
            ts.isGetAccessorDeclaration(p) ||
            ts.isSetAccessorDeclaration(p)) {
            const n = p.name;
            if (ts.isIdentifier(n) || ts.isStringLiteral(n))
                keys.add(n.text);
        }
    }
}
function collectValueProps(ts, node, props) {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isTypeNode(node))
        return;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
        const p = node.parent;
        if (p && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.left === node) {
            props.add(node.name.text);
        }
    }
    if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && !ts.isInterfaceDeclaration(node.parent)) {
        props.add(node.name.text);
    }
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
        props.add(node.name.text);
    }
    if (ts.isShorthandPropertyAssignment(node))
        props.add(node.name.text);
}
//# sourceMappingURL=exports.js.map