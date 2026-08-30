import { createHash } from "node:crypto";
export const ENVELOPE_VERSION = 1;
export function emptyHyrum() {
    return {
        errorMessage: false,
        toString: false,
        json: false,
        nan: false,
        sparseArray: false,
        keyOrder: false,
        prototype: false,
        mutation: false,
        dateIdentity: false,
        sameReference: false,
        signedZero: false,
    };
}
export function hashEnvelope(env) {
    const copy = { ...env, traces: [] };
    return createHash("sha256")
        .update(canonical(copy))
        .digest("hex");
}
/** Persist envelopes without traces (those live in traces.jsonl). */
export function envelopeForDisk(env) {
    return { ...env, traces: [] };
}
function canonical(value) {
    return JSON.stringify(sortKeys(value));
}
function sortKeys(value) {
    if (Array.isArray(value))
        return value.map(sortKeys);
    if (value && typeof value === "object") {
        const o = value;
        const out = {};
        for (const k of Object.keys(o).sort())
            out[k] = sortKeys(o[k]);
        return out;
    }
    return value;
}
//# sourceMappingURL=types.js.map