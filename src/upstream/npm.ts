import { fetchJson, sourceErr, sourceOk, type SourceResult } from "./status.ts";

export interface NpmLatest {
  version: string;
  time?: string;
  versions?: string[];
}

export async function npmLatest(
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SourceResult<NpmLatest>> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
  const got = await fetchJson(url, {}, fetchImpl);
  if (got.status !== "success") {
    return { status: got.status, detail: `npm registry ${got.detail}` };
  }
  const json = got.value;
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return sourceErr("malformed", "npm registry body is not an object");
  }
  const rec = json as {
    version?: unknown;
    "dist-tags"?: { latest?: unknown };
    versions?: unknown;
    time?: { modified?: unknown };
  };
  const version =
    typeof rec["dist-tags"]?.latest === "string"
      ? rec["dist-tags"].latest
      : typeof rec.version === "string"
        ? rec.version
        : undefined;
  if (!version) {
    return sourceErr("malformed", "npm registry response missing version");
  }
  const versions = rec.versions && typeof rec.versions === "object" && !Array.isArray(rec.versions)
    ? Object.keys(rec.versions as Record<string, unknown>)
    : undefined;
  const time = typeof rec.time?.modified === "string" ? rec.time.modified : undefined;
  return sourceOk({ version, time, versions });
}
