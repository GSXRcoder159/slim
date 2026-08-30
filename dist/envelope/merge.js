import { emptyHyrum } from "./types.js";
import { attributeTraces, locMatch, symbolMatches } from "../trace/attribute.js";
export function hyrumFromTraces(traces) {
    const h = {};
    for (const t of traces) {
        if (t.threw?.message)
            h.errorMessage = true;
        if (t.mutatedArgIndexes?.length)
            h.mutation = true;
        for (const v of t.args)
            walkSlim(v, h);
        if (t.thisArg)
            walkSlim(t.thisArg, h);
        if (t.result)
            walkSlim(t.result, h, 0, true);
        observeIdentity(t, h);
    }
    return h;
}
function walkSlim(v, h, depth = 0, fromResult = false) {
    if (depth > 24)
        return;
    if (v.t === "trunc")
        return;
    if (v.t === "num") {
        if (v.v === "NaN")
            h.nan = true;
        if (v.v === "-0")
            h.signedZero = true;
    }
    if (v.t === "arr") {
        if (v.holes.length)
            h.sparseArray = true;
        if (fromResult)
            h.json = true;
        for (const el of v.v)
            walkSlim(el, h, depth + 1, fromResult);
    }
    if (v.t === "obj") {
        if (v.keys.length >= 2)
            h.keyOrder = true;
        if (v.proto === "null" || v.proto === "other")
            h.prototype = true;
        if (v.toStr || v.keys.includes("toString"))
            h.toString = true;
        if (fromResult)
            h.json = true;
        for (const k of v.keys) {
            const child = v.v[k];
            if (child)
                walkSlim(child, h, depth + 1, fromResult);
        }
        for (const s of v.syms ?? [])
            walkSlim(s.v, h, depth + 1, fromResult);
    }
    if (v.t === "map") {
        for (const [k, val] of v.v) {
            walkSlim(k, h, depth + 1, fromResult);
            walkSlim(val, h, depth + 1, fromResult);
        }
    }
    if (v.t === "set") {
        for (const el of v.v)
            walkSlim(el, h, depth + 1, fromResult);
    }
}
function isRegistered(v) {
    return (v.t === "obj" ||
        v.t === "arr" ||
        v.t === "map" ||
        v.t === "set" ||
        v.t === "date" ||
        v.t === "err" ||
        v.t === "fn" ||
        v.t === "bytes" ||
        v.t === "promise" ||
        v.t === "regexp");
}
function assignIds(v, nodes) {
    if (v.t === "ref" || v.t === "trunc")
        return;
    if (isRegistered(v))
        nodes.push(v);
    if (v.t === "arr") {
        for (const el of v.v)
            assignIds(el, nodes);
    }
    if (v.t === "obj") {
        for (const k of v.keys) {
            const child = v.v[k];
            if (child)
                assignIds(child, nodes);
        }
        for (const s of v.syms ?? [])
            assignIds(s.v, nodes);
    }
    if (v.t === "map") {
        for (const [k, val] of v.v) {
            assignIds(k, nodes);
            assignIds(val, nodes);
        }
    }
    if (v.t === "set") {
        for (const el of v.v)
            assignIds(el, nodes);
    }
}
function collectRefs(v, refs, depth = 0) {
    if (depth > 24)
        return;
    if (v.t === "ref") {
        refs.push(v.id);
        return;
    }
    if (v.t === "arr") {
        for (const el of v.v)
            collectRefs(el, refs, depth + 1);
    }
    if (v.t === "obj") {
        for (const k of v.keys) {
            const child = v.v[k];
            if (child)
                collectRefs(child, refs, depth + 1);
        }
        for (const s of v.syms ?? [])
            collectRefs(s.v, refs, depth + 1);
    }
    if (v.t === "map") {
        for (const [k, val] of v.v) {
            collectRefs(k, refs, depth + 1);
            collectRefs(val, refs, depth + 1);
        }
    }
    if (v.t === "set") {
        for (const el of v.v)
            collectRefs(el, refs, depth + 1);
    }
}
function observeIdentity(t, h) {
    if (!t.result)
        return;
    const nodes = [];
    for (const a of t.args)
        assignIds(a, nodes);
    if (t.thisArg)
        assignIds(t.thisArg, nodes);
    const argN = nodes.length;
    const refs = [];
    collectRefs(t.result, refs);
    for (const id of refs) {
        if (id < 0 || id >= argN)
            continue;
        h.sameReference = true;
        if (nodes[id]?.t === "date")
            h.dateIdentity = true;
    }
}
function orHyrum(base, extra) {
    const out = { ...emptyHyrum(), ...base };
    for (const k of Object.keys(extra)) {
        if (extra[k])
            out[k] = true;
    }
    return out;
}
export function mergeTraces(env, traces, opts) {
    const attributed = opts?.root ? attributeTraces(env, traces, opts.root) : traces;
    const symbols = env.symbols.map((s) => {
        const hits = attributed.filter((t) => symbolMatches(s.exportName, t.symbol));
        const tracedIds = new Set();
        for (const t of hits) {
            if (t.callSiteId && !t.unmatched)
                tracedIds.add(t.callSiteId);
        }
        return {
            ...s,
            hyrum: orHyrum(s.hyrum, hyrumFromTraces(hits)),
            coverage: {
                callSitesStatic: s.callSites.length,
                callSitesTraced: tracedIds.size,
            },
        };
    });
    const unknowns = env.unknowns.map((u) => {
        if (u.kind !== "dynamic-member")
            return u;
        const members = [
            ...new Set(attributed
                .filter((t) => t.site && locMatch(t.site, u.loc, opts?.root ?? process.cwd()))
                .map((t) => (t.resultMember ? `${baseSymbol(t.symbol)}.${t.resultMember}` : t.symbol))
                .filter((name) => name.length > 0)),
        ];
        if (!members.length)
            return u;
        return { ...u, traceObservedMembers: members };
    });
    return { ...env, symbols, unknowns, traces: [...env.traces, ...attributed] };
}
function baseSymbol(symbol) {
    return symbol.replace(/\(\)$/, "").split(".")[0] ?? symbol;
}
//# sourceMappingURL=merge.js.map