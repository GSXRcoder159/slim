const SKIP_SYMBOLS = new Set(["*", "(scan)"]);
function isTrackedSymbol(name) {
    return Boolean(name) && !SKIP_SYMBOLS.has(name);
}
function canonShape(shape) {
    if (!shape)
        return null;
    return {
        kind: shape.kind,
        literals: shape.literals ? [...shape.literals].map((v) => JSON.stringify(v)).sort() : [],
        props: shape.props
            ? Object.fromEntries(Object.keys(shape.props).sort().map((k) => [k, canonShape(shape.props[k])]))
            : {},
        elements: (shape.elements ?? []).map(canonShape),
        fnArity: shape.fnArity ?? null,
    };
}
export function callSiteFingerprint(site) {
    const argc = site.argc ?? { min: 0, max: null, observed: [] };
    const observed = [...(argc.observed ?? [])].sort((a, b) => a - b);
    return JSON.stringify({
        exportName: site.exportName,
        memberPath: site.memberPath ?? [],
        thisBinding: site.thisBinding?.kind ?? "unbound",
        min: argc.min ?? 0,
        max: argc.max,
        observed,
        shapes: (site.argShapes ?? []).map(canonShape),
        resultMembers: [...(site.resultMembers ?? [])].sort(),
    });
}
function symbolNames(env) {
    return (env.symbols ?? []).map((s) => s.exportName).filter(isTrackedSymbol);
}
function fingerprintsFor(env, exportName) {
    const out = new Set();
    for (const s of env.symbols ?? []) {
        if (s.exportName !== exportName)
            continue;
        for (const c of s.callSites ?? [])
            out.add(callSiteFingerprint(c));
    }
    return out;
}
function resultMembers(env, exportName) {
    const out = new Set();
    for (const s of env.symbols ?? []) {
        if (s.exportName !== exportName)
            continue;
        for (const m of s.resultMembers ?? [])
            out.add(m);
        for (const c of s.callSites ?? []) {
            for (const m of c.resultMembers ?? [])
                out.add(m);
        }
    }
    return out;
}
function importKinds(env) {
    return new Set((env.imports ?? []).map((i) => i.kind));
}
function unknownKeys(env) {
    return new Set((env.unknowns ?? []).map((u) => `${u.kind}:${u.id}`));
}
export function diffEnvelope(saved, live) {
    const drift = [];
    const savedNames = new Set(symbolNames(saved));
    for (const name of symbolNames(live)) {
        if (!savedNames.has(name)) {
            drift.push({ kind: "symbol", detail: `added symbol ${name}` });
        }
    }
    for (const name of savedNames) {
        const liveSym = (live.symbols ?? []).find((s) => s.exportName === name);
        if (!liveSym)
            continue;
        const savedPrints = fingerprintsFor(saved, name);
        for (const fp of fingerprintsFor(live, name)) {
            if (!savedPrints.has(fp)) {
                drift.push({ kind: "shape", detail: `new call shape on ${name}` });
                break;
            }
        }
        const savedMembers = resultMembers(saved, name);
        for (const m of resultMembers(live, name)) {
            if (!savedMembers.has(m)) {
                drift.push({ kind: "resultMember", detail: `new result member ${name}.${m}` });
            }
        }
    }
    const savedKinds = importKinds(saved);
    if (savedKinds.size) {
        for (const kind of importKinds(live)) {
            if (!savedKinds.has(kind)) {
                drift.push({ kind: "import", detail: `new import form ${kind}` });
            }
        }
    }
    const savedEnv = new Set(saved.env ?? []);
    if (savedEnv.size) {
        for (const tag of live.env ?? []) {
            if (!savedEnv.has(tag)) {
                drift.push({ kind: "env", detail: `new environment ${tag}` });
            }
        }
    }
    const savedUnknown = unknownKeys(saved);
    for (const key of unknownKeys(live)) {
        if (!savedUnknown.has(key)) {
            const [kind] = key.split(":");
            drift.push({ kind: "unknown", detail: `new unknown ${kind}` });
        }
    }
    return drift;
}
//# sourceMappingURL=drift.js.map