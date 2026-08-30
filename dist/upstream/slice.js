import { formatAffectedRange } from "./osv.js";
const POLLUTION = /prototype.?pollution|__proto__|CWE-1321/i;
const POLLUTION_SYMBOLS = new Set(["get", "set", "merge", "defaultsDeep", "zipObjectDeep"]);
export function sliceExposure(vuln, usedSymbols) {
    const affectedRange = formatAffectedRange(vuln);
    const text = `${vuln.summary ?? ""}\n${vuln.details ?? ""}\n${(vuln.aliases ?? []).join(" ")}`;
    const cwes = vuln.database_specific?.cwe_ids ?? [];
    const used = new Set(usedSymbols);
    for (const s of usedSymbols) {
        const re = new RegExp(`\\b${escapeRe(s)}\\b`, "i");
        if (re.test(text) && s.length > 2) {
            return {
                exposure: "exposed",
                mappedEvidence: `used symbol ${s} mentioned in advisory text`,
                unmappedReason: null,
                affectedRange,
            };
        }
    }
    if (cwes.includes("CWE-1321") || POLLUTION.test(text)) {
        if ([...used].some((s) => POLLUTION_SYMBOLS.has(s))) {
            const hit = [...used].filter((s) => POLLUTION_SYMBOLS.has(s)).join(", ");
            return {
                exposure: "exposed",
                mappedEvidence: `CWE-1321 / prototype pollution maps to used symbols ${hit}`,
                unmappedReason: null,
                affectedRange,
            };
        }
        return {
            exposure: "unmapped",
            mappedEvidence: "CWE-1321 / prototype pollution advisory",
            unmappedReason: "prototype pollution advisory does not map to used exports",
            affectedRange,
        };
    }
    if (!mentionsAnyExport(text) && usedSymbols.length) {
        return {
            exposure: "unmapped",
            mappedEvidence: "advisory text does not name a function, method, or export",
            unmappedReason: "could not map advisory to used exports",
            affectedRange,
        };
    }
    return {
        exposure: "not-exposed",
        mappedEvidence: "advisory does not mention used exports",
        unmappedReason: null,
        affectedRange,
    };
}
function mentionsAnyExport(text) {
    return /\b(function|method|export)\b/i.test(text);
}
function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
//# sourceMappingURL=slice.js.map