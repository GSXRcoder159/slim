export interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  affected?: Array<{ package?: { name?: string; ecosystem?: string } }>;
  database_specific?: { cwe_ids?: string[] };
}

export async function queryOsv(
  name: string,
  version: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OsvVuln[]> {
  const res = await fetchImpl("https://api.osv.dev/v1/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      package: { name, ecosystem: "npm" },
      version,
    }),
  });
  if (!res.ok) {
    throw new Error(`osv.dev HTTP ${res.status}`);
  }
  const json = (await res.json()) as { vulns?: OsvVuln[] };
  return json.vulns ?? [];
}
