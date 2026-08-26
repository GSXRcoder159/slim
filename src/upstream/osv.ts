import { fetchJson, sourceErr, sourceOk, type SourceResult } from "./status.ts";

export interface OsvRange {
  type?: string;
  events?: Array<{ introduced?: string; fixed?: string; last_affected?: string }>;
}

export interface OsvAffected {
  package?: { name?: string; ecosystem?: string };
  ranges?: OsvRange[];
  versions?: string[];
}

export interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  affected?: OsvAffected[];
  database_specific?: { cwe_ids?: string[] };
}

const OSV_QUERY = "https://api.osv.dev/v1/query";

export function formatAffectedRange(vuln: OsvVuln): string {
  const parts: string[] = [];
  for (const a of vuln.affected ?? []) {
    for (const r of a.ranges ?? []) {
      const events = (r.events ?? [])
        .map((e) =>
          e.introduced
            ? `introduced:${e.introduced}`
            : e.fixed
              ? `fixed:${e.fixed}`
              : e.last_affected
                ? `last_affected:${e.last_affected}`
                : "",
        )
        .filter(Boolean);
      if (events.length) parts.push(events.join(" "));
    }
    if (a.versions?.length) parts.push(`versions:${a.versions.join(",")}`);
  }
  return parts.join("; ") || "unspecified";
}

export async function queryOsv(
  name: string,
  version: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SourceResult<OsvVuln[]>> {
  const got = await fetchJson(
    OSV_QUERY,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        package: { name, ecosystem: "npm" },
        version,
      }),
    },
    fetchImpl,
  );
  if (got.status !== "success") {
    return { status: got.status, detail: `osv.dev ${got.detail}` };
  }
  const json = got.value;
  if (!json || typeof json !== "object") {
    return sourceErr("malformed", "osv.dev body is not an object");
  }
  const vulns = (json as { vulns?: unknown }).vulns;
  if (vulns === undefined) return sourceOk([]);
  if (!Array.isArray(vulns)) return sourceErr("malformed", "osv.dev vulns is not an array");
  const out: OsvVuln[] = [];
  for (const v of vulns) {
    if (!v || typeof v !== "object" || typeof (v as OsvVuln).id !== "string") {
      return sourceErr("malformed", "osv.dev vuln missing id");
    }
    out.push(v as OsvVuln);
  }
  return sourceOk(out);
}
