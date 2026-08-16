import type { OsvVuln } from "./osv.ts";

const POLLUTION = /prototype.?pollution|__proto__|CWE-1321/i;
const POLLUTION_SYMBOLS = new Set(["get", "set", "merge", "defaultsDeep", "zipObjectDeep"]);

export type Exposure = "exposed" | "unmapped" | "not-exposed";

export function sliceExposure(
  vuln: OsvVuln,
  usedSymbols: string[],
): Exposure {
  const text = `${vuln.summary ?? ""}\n${vuln.details ?? ""}\n${(vuln.aliases ?? []).join(" ")}`;
  const cwes = vuln.database_specific?.cwe_ids ?? [];
  const used = new Set(usedSymbols);
  for (const s of usedSymbols) {
    const re = new RegExp(`\\b${escapeRe(s)}\\b`, "i");
    if (re.test(text) && s.length > 2) return "exposed";
  }
  if (cwes.includes("CWE-1321") || POLLUTION.test(text)) {
    if ([...used].some((s) => POLLUTION_SYMBOLS.has(s))) return "exposed";
    return "unmapped";
  }
  if (!mentionsAnyExport(text) && usedSymbols.length) return "unmapped";
  return "not-exposed";
}

function mentionsAnyExport(text: string): boolean {
  return /\b(function|method|export)\b/i.test(text);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
