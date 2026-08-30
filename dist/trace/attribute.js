import { toProjectRel } from "../analyze/model.js";
export function attributeTraces(env, traces, root) {
    const sites = env.symbols.flatMap((s) => s.callSites.map((c) => ({ exportName: s.exportName, site: c })));
    const first = traces.map((t) => attributeOne(t, sites, root));
    const byOrigin = new Map();
    for (const t of first) {
        if (t.originId)
            byOrigin.set(t.originId, t);
    }
    return first.map((t) => {
        if (!t.parentOriginId)
            return t;
        const parent = byOrigin.get(t.parentOriginId);
        if (parent?.callSiteId) {
            return { ...t, callSiteId: parent.callSiteId, unmatched: false };
        }
        if (parent && parent.unmatched) {
            return { ...t, unmatched: true, callSiteId: t.callSiteId ?? null };
        }
        return attributeOne({ ...t, parentOriginId: undefined }, sites, root);
    });
}
function attributeOne(t, sites, root) {
    if (t.parentOriginId) {
        return { ...t, callSiteId: t.callSiteId ?? null };
    }
    const candidates = sites.filter((s) => symbolMatches(s.exportName, t.symbol));
    const hit = matchSite(t, candidates, root);
    if (hit)
        return { ...t, callSiteId: hit.site.id, unmatched: false };
    return { ...t, callSiteId: null, unmatched: true };
}
export function symbolMatches(exportName, symbol) {
    if (matchesExport(exportName, symbol))
        return true;
    if (symbol.startsWith("default."))
        return matchesExport(exportName, symbol.slice("default.".length));
    if (symbol.startsWith("_."))
        return matchesExport(exportName, symbol.slice(2));
    if (symbol === "default")
        return true;
    return false;
}
function matchesExport(exportName, symbol) {
    return (symbol === exportName ||
        symbol === `${exportName}()` ||
        symbol.startsWith(`${exportName}.`));
}
function matchSite(t, candidates, root) {
    if (!candidates.length)
        return undefined;
    if (!t.site)
        return candidates.length === 1 ? candidates[0] : undefined;
    const file = normalizeTraceFile(t.site.file, root);
    const onFile = candidates.filter((c) => filesMatch(c.site.loc.file, file));
    if (!onFile.length)
        return undefined;
    const onLine = onFile.filter((c) => c.site.loc.line === t.site.line);
    const linePool = onLine.length ? onLine : onFile;
    if (linePool.length === 1)
        return linePool[0];
    const onCol = linePool.filter((c) => c.site.loc.column === t.site.column);
    if (onCol.length === 1)
        return onCol[0];
    return undefined;
}
export function locMatch(site, loc, root) {
    return filesMatch(loc.file, normalizeTraceFile(site.file, root)) && loc.line === site.line;
}
function normalizeTraceFile(file, root) {
    const stripped = file.replace(/\\/g, "/").replace(/\?.*$/, "");
    const rel = toProjectRel(stripped, root);
    return rel.replace(/\.js$/, ".ts").replace(/\.mjs$/, ".ts").replace(/\.cjs$/, ".ts");
}
function filesMatch(envelopeFile, traceFile) {
    if (envelopeFile === traceFile)
        return true;
    const a = envelopeFile.replace(/\.js$/, ".ts");
    const b = traceFile.replace(/\.js$/, ".ts");
    return a === b;
}
//# sourceMappingURL=attribute.js.map