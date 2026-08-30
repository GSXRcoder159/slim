import { locOf, toProjectRel, uid } from "./model.js";
import { localFromImportCall, specifierMatches } from "./reexports.js";
import { asBindingEscape, namespaceIdent, peelCallApplyBind, resolveCallee, thisOf, unwrapExpr, originCallSite, } from "./callee.js";
import { bindPatternOrIdent, identifierValueEscape, isDynamicCodeCallee, pushUnknown, } from "./flow.js";
import { argIsTsAny, argShapeUnresolved, shapeOf } from "./shapes.js";
export function walkUses(ts, sf, bindings, wanted, callSites, unknowns, resultMembers, extra, checker) {
    const nf = toProjectRel(sf.fileName, extra.root);
    const bindByLocal = bindings.filter((b) => b.loc.file === nf && specifierMatches(b.specifier, wanted));
    const localSet = new Map(bindByLocal.map((b) => [b.local, b]));
    const dynamicAliases = new Map();
    const resultScopes = [new Map()];
    const callByNode = new WeakMap();
    const lookupResult = (name) => {
        for (let i = resultScopes.length - 1; i >= 0; i--) {
            const hit = resultScopes[i].get(name);
            if (hit)
                return hit;
        }
        return undefined;
    };
    const pushNsEscape = (node, b) => {
        unknowns.push({
            id: uid("nsesc", sf, node, extra.root),
            loc: locOf(sf, node, extra.root),
            kind: "namespace-escape",
            detail: `namespace value of ${b.specifier} escaped`,
            widensTo: "all-exports",
            traceObservedMembers: null,
        });
    };
    const visit = (node) => {
        const scoped = isBindingScope(ts, node);
        if (scoped)
            resultScopes.push(new Map());
        const dynCall = ts.isCallExpression(node) ? isDynamicCodeCallee(ts, node.expression, dynamicAliases) : null;
        if (dynCall) {
            pushUnknown(ts, sf, node, extra, unknowns, "eval", dynCall === "Function" ? "Function()" : "eval()", "refuse", dynCall === "Function" ? "fncall" : "eval");
        }
        const dynNew = ts.isNewExpression(node) && node.expression
            ? isDynamicCodeCallee(ts, node.expression, dynamicAliases)
            : null;
        if (dynNew) {
            pushUnknown(ts, sf, node, extra, unknowns, "eval", "new Function", "refuse", "fn");
        }
        if (ts.isCallExpression(node)) {
            const cal = unwrapExpr(ts, node.expression);
            if (ts.isIdentifier(cal) && cal.text === "require") {
                const arg = node.arguments[0];
                if (arg && !ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) {
                    unknowns.push({
                        id: uid("dynreq", sf, node, extra.root),
                        loc: locOf(sf, node, extra.root),
                        kind: "dynamic-specifier",
                        detail: "require(non-literal)",
                        widensTo: "refuse",
                        traceObservedMembers: null,
                    });
                }
            }
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const arg = node.arguments[0];
            if (arg && !ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) {
                unknowns.push({
                    id: uid("dynimp", sf, node, extra.root),
                    loc: locOf(sf, node, extra.root),
                    kind: "dynamic-specifier",
                    detail: "import(non-literal)",
                    widensTo: "refuse",
                    traceObservedMembers: null,
                });
            }
        }
        if (ts.isNewExpression(node) && node.expression) {
            const info = resolveCallee(ts, node.expression, localSet, wanted);
            if (info) {
                if (info.dynamic) {
                    unknowns.push({
                        id: uid("dynnew", sf, node, extra.root),
                        loc: locOf(sf, node, extra.root),
                        kind: "dynamic-member",
                        detail: `computed member on ${info.exportName}`,
                        widensTo: "all-exports",
                        traceObservedMembers: null,
                    });
                }
                else {
                    const args = [...(node.arguments ?? [])];
                    const built = callArgs(ts, args, null, checker);
                    const site = {
                        id: uid("new", sf, node, extra.root),
                        loc: locOf(sf, node, extra.root),
                        exportName: info.exportName,
                        memberPath: info.memberPath,
                        thisBinding: { kind: "unbound" },
                        argc: {
                            min: built.spread ? 0 : built.argc,
                            max: built.spread ? null : built.argc,
                            observed: [built.argc],
                        },
                        argShapes: built.argShapes,
                        spread: built.spread,
                        resultMembers: [],
                    };
                    callSites.push(site);
                    callByNode.set(node, site);
                    const resultLocal = localFromImportCall(ts, node);
                    if (resultLocal)
                        resultScopes[resultScopes.length - 1].set(resultLocal, site);
                }
            }
        }
        if (ts.isCallExpression(node)) {
            const peeled = peelCallApplyBind(ts, node.expression, localSet, wanted);
            const info = resolveCallee(ts, peeled.callee, localSet, wanted);
            if (info) {
                if (info.dynamic) {
                    unknowns.push({
                        id: uid("dyn", sf, node, extra.root),
                        loc: locOf(sf, node, extra.root),
                        kind: "dynamic-member",
                        detail: `computed member on ${info.exportName}`,
                        widensTo: "all-exports",
                        traceObservedMembers: null,
                    });
                }
                else {
                    const built = callArgs(ts, [...node.arguments], peeled.thisKind?.kind ?? null, checker);
                    const thisBinding = peeled.thisKind ?? thisOf(ts, peeled.callee);
                    const site = {
                        id: uid("call", sf, node, extra.root),
                        loc: locOf(sf, node, extra.root),
                        exportName: info.exportName,
                        memberPath: info.memberPath,
                        thisBinding,
                        argc: {
                            min: built.spread ? 0 : built.argc,
                            max: built.spread ? null : built.argc,
                            observed: [built.argc],
                        },
                        argShapes: built.argShapes,
                        spread: built.spread,
                        resultMembers: [],
                    };
                    callSites.push(site);
                    callByNode.set(node, site);
                    const resultLocal = localFromImportCall(ts, node);
                    if (resultLocal)
                        resultScopes[resultScopes.length - 1].set(resultLocal, site);
                    noteUnresolvedArgs(ts, sf, node, extra, unknowns, built, info.exportName);
                    if (built.spread) {
                        unknowns.push({
                            id: uid("spread", sf, node, extra.root),
                            loc: locOf(sf, node, extra.root),
                            kind: "spread-args",
                            detail: `spread arguments on ${info.exportName}`,
                            widensTo: "full-signature",
                            traceObservedMembers: null,
                        });
                    }
                    for (const a of built.rawArgs) {
                        if (!argIsTsAny(ts, a, checker))
                            continue;
                        unknowns.push({
                            id: uid("any", sf, a, extra.root),
                            loc: locOf(sf, a, extra.root),
                            kind: "ts-any",
                            detail: `any-typed argument to ${info.exportName}`,
                            widensTo: "full-signature",
                            traceObservedMembers: null,
                        });
                    }
                }
            }
            for (const arg of node.arguments) {
                const escaped = asBindingEscape(ts, arg, localSet);
                if (!escaped)
                    continue;
                if (escaped.namespace) {
                    const expr = ts.isSpreadElement(arg) ? arg.expression : arg;
                    const b = namespaceIdent(ts, expr, localSet);
                    if (b)
                        pushNsEscape(arg, b);
                    continue;
                }
                unknowns.push({
                    id: uid("esc", sf, arg, extra.root),
                    loc: locOf(sf, arg, extra.root),
                    kind: "binding-escape",
                    detail: `${escaped.name} passed as callback (iteratee arity 3 assumed for get)`,
                    widensTo: "full-signature",
                    traceObservedMembers: null,
                });
                if (escaped.name === "get" || escaped.name.endsWith(".get")) {
                    callSites.push({
                        id: uid("mapget", sf, arg, extra.root),
                        loc: locOf(sf, arg, extra.root),
                        exportName: "get",
                        memberPath: ["get"],
                        thisBinding: { kind: "unknown", reason: "iteratee" },
                        argc: { min: 1, max: 3, observed: [3] },
                        argShapes: [{ kind: "any" }, { kind: "any" }, { kind: "any" }],
                        spread: false,
                        resultMembers: [],
                    });
                }
            }
        }
        if (ts.isTaggedTemplateExpression(node)) {
            const info = resolveCallee(ts, node.tag, localSet, wanted);
            if (info && !info.dynamic) {
                const interpolations = ts.isTemplateExpression(node.template) ? node.template.templateSpans.length : 0;
                const argc = interpolations + 1;
                callSites.push({
                    id: uid("tag", sf, node, extra.root),
                    loc: locOf(sf, node, extra.root),
                    exportName: info.exportName,
                    memberPath: info.memberPath,
                    thisBinding: { kind: "unbound" },
                    argc: { min: argc, max: argc, observed: [argc] },
                    argShapes: Array.from({ length: argc }, () => ({ kind: "any" })),
                    spread: false,
                    resultMembers: [],
                });
            }
        }
        if (ts.isSpreadElement(node) && ts.isArrayLiteralExpression(node.parent)) {
            const b = namespaceIdent(ts, node.expression, localSet);
            if (b)
                pushNsEscape(node, b);
        }
        if (ts.isSpreadAssignment(node)) {
            const b = namespaceIdent(ts, node.expression, localSet);
            if (b)
                pushNsEscape(node, b);
        }
        if (ts.isPropertyAccessExpression(node)) {
            const info = resolveCallee(ts, node.expression, localSet, wanted);
            if (info && !info.dynamic && ts.isIdentifier(node.name)) {
                const parentCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
                if (!parentCall) {
                    const set = resultMembers.get(info.exportName) ?? new Set();
                    set.add(node.name.text);
                    resultMembers.set(info.exportName, set);
                }
            }
        }
        if (ts.isElementAccessExpression(node)) {
            const obj = unwrapExpr(ts, node.expression);
            if (ts.isIdentifier(obj) && localSet.has(obj.text)) {
                const arg = node.argumentExpression;
                if (arg && !ts.isStringLiteral(arg) && !ts.isNumericLiteral(arg)) {
                    unknowns.push({
                        id: uid("dynm", sf, node, extra.root),
                        loc: locOf(sf, node, extra.root),
                        kind: "dynamic-member",
                        detail: `computed access ${obj.text}[...]`,
                        widensTo: "all-exports",
                        traceObservedMembers: null,
                    });
                }
            }
        }
        ts.forEachChild(node, visit);
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
            const resultSite = originCallSite(ts, node.expression, lookupResult, callByNode);
            const fromIdent = ts.isIdentifier(unwrapExpr(ts, node.expression));
            const invoked = ts.isCallExpression(node.parent) && node.parent.expression === node;
            if (resultSite && (fromIdent || invoked)) {
                const mem = node.name.text;
                if (!resultSite.resultMembers.includes(mem))
                    resultSite.resultMembers.push(mem);
                const set = resultMembers.get(resultSite.exportName) ?? new Set();
                set.add(mem);
                resultMembers.set(resultSite.exportName, set);
            }
        }
        if (ts.isVariableDeclaration(node)) {
            bindPatternOrIdent(ts, node.name, node.initializer, localSet, null);
            const kind = node.initializer ? isDynamicCodeCallee(ts, node.initializer, dynamicAliases) : null;
            if (kind && ts.isIdentifier(node.name))
                dynamicAliases.set(node.name.text, kind);
        }
        if (ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(node.left)) {
            bindPatternOrIdent(ts, node.left, node.right, localSet, null);
            const kind = isDynamicCodeCallee(ts, node.right, dynamicAliases);
            if (kind)
                dynamicAliases.set(node.left.text, kind);
        }
        if (ts.isIdentifier(node)) {
            const escaped = identifierValueEscape(ts, node, localSet);
            if (escaped) {
                if (escaped.imported === "*")
                    pushNsEscape(node, escaped);
                else {
                    pushUnknown(ts, sf, node, extra, unknowns, "binding-escape", `${escaped.imported === "default" ? escaped.local : escaped.imported} escaped`, "full-signature", "esc");
                    if (escaped.imported === "get" || escaped.imported.endsWith(".get")) {
                        const parentCall = node.parent && ts.isCallExpression(node.parent);
                        if (parentCall && [...node.parent.arguments].some((a) => a === node || (ts.isSpreadElement(a) && a.expression === node))) {
                            callSites.push({
                                id: uid("mapget", sf, node, extra.root),
                                loc: locOf(sf, node, extra.root),
                                exportName: "get",
                                memberPath: ["get"],
                                thisBinding: { kind: "unknown", reason: "iteratee" },
                                argc: { min: 1, max: 3, observed: [3] },
                                argShapes: [{ kind: "any" }, { kind: "any" }, { kind: "any" }],
                                spread: false,
                                resultMembers: [],
                            });
                        }
                    }
                }
            }
        }
        if (scoped)
            resultScopes.pop();
    };
    visit(sf);
}
function callArgs(ts, raw, invoke, checker) {
    let args = [...raw];
    let spread = args.some((a) => ts.isSpreadElement(a));
    if (invoke === "call" || invoke === "bind") {
        args = args.slice(1);
        spread = args.some((a) => ts.isSpreadElement(a));
    }
    else if (invoke === "apply") {
        const arr = args[1] ? unwrapExpr(ts, args[1]) : undefined;
        if (arr && ts.isArrayLiteralExpression(arr)) {
            args = [...arr.elements.filter((e) => !ts.isOmittedExpression(e))];
            spread = args.some((a) => ts.isSpreadElement(a));
        }
        else {
            return {
                argc: 0,
                argShapes: [{ kind: "unknown" }],
                spread: true,
                rawArgs: args[1] ? [args[1]] : [],
            };
        }
    }
    const argShapes = args.map((a) => {
        if (ts.isSpreadElement(a) || argIsTsAny(ts, a, checker))
            return { kind: "unknown" };
        return shapeOf(ts, a, checker);
    });
    return { argc: args.length, argShapes, spread, rawArgs: args };
}
function noteUnresolvedArgs(ts, sf, node, extra, unknowns, built, exportName) {
    if (built.spread)
        return;
    if (!built.argShapes.some(argShapeUnresolved))
        return;
    pushUnknown(ts, sf, node, extra, unknowns, "unresolved-shape", `unresolved argument shape on ${exportName}`, "full-signature", "shape");
}
function isBindingScope(ts, node) {
    return (ts.isBlock(node) ||
        ts.isModuleBlock(node) ||
        ts.isCaseBlock(node) ||
        ts.isCatchClause(node) ||
        ts.isForStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isClassStaticBlockDeclaration(node));
}
//# sourceMappingURL=calls.js.map