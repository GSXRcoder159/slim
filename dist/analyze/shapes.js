import { emptyHyrum } from "../envelope/types.js";
export function shapeOf(ts, node, checker) {
    if (ts.isSpreadElement(node))
        return { kind: "unknown" };
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return { kind: "literal", literals: [node.text] };
    }
    if (ts.isNumericLiteral(node))
        return { kind: "literal", literals: [Number(node.text)] };
    if (node.kind === ts.SyntaxKind.TrueKeyword)
        return { kind: "literal", literals: [true] };
    if (node.kind === ts.SyntaxKind.FalseKeyword)
        return { kind: "literal", literals: [false] };
    if (node.kind === ts.SyntaxKind.NullKeyword)
        return { kind: "literal", literals: [null] };
    if (node.kind === ts.SyntaxKind.UndefinedKeyword)
        return { kind: "literal", literals: [undefined] };
    if (ts.isArrayLiteralExpression(node)) {
        const unresolved = node.elements.some((el) => ts.isOmittedExpression(el) || ts.isSpreadElement(el));
        if (unresolved && node.elements.every((el) => ts.isOmittedExpression(el) || ts.isSpreadElement(el))) {
            return { kind: "unknown" };
        }
        return {
            kind: "array",
            elements: node.elements.map((el) => {
                if (ts.isOmittedExpression(el) || ts.isSpreadElement(el))
                    return { kind: "unknown" };
                return shapeOf(ts, el, checker);
            }),
        };
    }
    if (ts.isObjectLiteralExpression(node)) {
        if (objectHasUnresolved(ts, node))
            return { kind: "unknown" };
        const props = {};
        for (const p of node.properties) {
            if (ts.isShorthandPropertyAssignment(p)) {
                props[p.name.text] = { kind: "any" };
            }
            else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
                props[p.name.text] = shapeOf(ts, p.initializer, checker);
            }
            else if (ts.isPropertyAssignment(p) && ts.isStringLiteral(p.name)) {
                props[p.name.text] = shapeOf(ts, p.initializer, checker);
            }
        }
        return { kind: "object", props };
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        return { kind: "function", fnArity: node.parameters.length };
    }
    if (checker) {
        const lits = typeLiterals(ts, checker.getTypeAtLocation(node));
        if (lits.length === 1)
            return { kind: "literal", literals: lits };
        if (lits.length > 1)
            return { kind: "union", literals: lits };
    }
    return { kind: "any" };
}
export function argShapeUnresolved(shape) {
    if (shape.kind === "unknown")
        return true;
    if (shape.kind === "array")
        return (shape.elements ?? []).some(argShapeUnresolved);
    if (shape.kind === "object")
        return Object.values(shape.props ?? {}).some(argShapeUnresolved);
    return false;
}
function objectHasUnresolved(ts, node) {
    for (const p of node.properties) {
        if (ts.isSpreadAssignment(p))
            return true;
        if (ts.isShorthandPropertyAssignment(p))
            continue;
        if (ts.isPropertyAssignment(p) && ts.isComputedPropertyName(p.name)) {
            const expr = unwrapParens(ts, p.name.expression);
            if (!ts.isStringLiteral(expr) && !ts.isNoSubstitutionTemplateLiteral(expr) && !ts.isNumericLiteral(expr)) {
                return true;
            }
        }
        if (ts.isMethodDeclaration(p) ||
            ts.isGetAccessorDeclaration(p) ||
            ts.isSetAccessorDeclaration(p) ||
            ts.isSpreadAssignment(p)) {
            return true;
        }
    }
    return false;
}
export function inferHyrum(exportName, sites) {
    const h = emptyHyrum();
    if (exportName === "get" || exportName === "set" || exportName === "has") {
        h.prototype = true;
        h.sameReference = exportName === "get";
    }
    if (exportName === "debounce" || exportName === "throttle") {
        h.errorMessage = true;
    }
    if (sites.some((s) => s.argShapes.some((a) => a.kind === "array"))) {
        h.sparseArray = true;
    }
    return h;
}
function identHasExplicitAny(ts, ident) {
    let scope = ident.parent;
    while (scope) {
        const params = functionParams(ts, scope);
        if (params) {
            for (const p of params) {
                if (ts.isIdentifier(p.name) && p.name.text === ident.text) {
                    return p.type?.kind === ts.SyntaxKind.AnyKeyword;
                }
            }
        }
        const vd = varDeclInScope(ts, scope, ident.text);
        if (vd)
            return vd.type?.kind === ts.SyntaxKind.AnyKeyword;
        scope = scope.parent;
    }
    return false;
}
export function argIsTsAny(ts, node, checker) {
    if (ts.isSpreadElement(node))
        return argIsTsAny(ts, node.expression, checker);
    node = unwrapParens(ts, node);
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        if (node.type.kind === ts.SyntaxKind.AnyKeyword)
            return true;
        return argIsTsAny(ts, node.expression, checker);
    }
    if (ts.isIdentifier(node) && identHasExplicitAny(ts, node))
        return true;
    if (checker) {
        const type = checker.getTypeAtLocation(node);
        if (type.flags & ts.TypeFlags.Any)
            return true;
    }
    return false;
}
function typeLiterals(ts, type) {
    if (type.isUnion())
        return type.types.flatMap((t) => typeLiterals(ts, t));
    if (type.isStringLiteral())
        return [type.value];
    if (type.isNumberLiteral())
        return [type.value];
    if (type.flags & ts.TypeFlags.BooleanLiteral) {
        return [type.intrinsicName === "true"];
    }
    if (type.flags & ts.TypeFlags.Null)
        return [null];
    if (type.flags & ts.TypeFlags.Undefined)
        return [undefined];
    return [];
}
function unwrapParens(ts, node) {
    let cur = node;
    while (ts.isParenthesizedExpression(cur))
        cur = cur.expression;
    return cur;
}
function functionParams(ts, node) {
    if (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) {
        return node.parameters;
    }
    return undefined;
}
function varDeclInScope(ts, scope, name) {
    const stmts = ts.isBlock(scope) || ts.isModuleBlock(scope) || ts.isSourceFile(scope)
        ? scope.statements
        : undefined;
    if (!stmts)
        return undefined;
    for (const s of stmts) {
        if (!ts.isVariableStatement(s))
            continue;
        for (const d of s.declarationList.declarations) {
            if (ts.isIdentifier(d.name) && d.name.text === name)
                return d;
        }
    }
    return undefined;
}
//# sourceMappingURL=shapes.js.map