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
    time?: unknown;
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
  if (!rec.versions || typeof rec.versions !== "object" || Array.isArray(rec.versions)) {
    return sourceErr("malformed", "npm registry versions is not an object");
  }
  const versions = Object.keys(rec.versions as Record<string, unknown>);
  if (!versions.includes(version)) {
    return sourceErr("malformed", "npm latest missing from versions");
  }
  if (!rec.time || typeof rec.time !== "object" || Array.isArray(rec.time)) {
    return sourceErr("malformed", "npm registry time is not an object");
  }
  const modified = (rec.time as { modified?: unknown }).modified;
  if (typeof modified !== "string" || !modified) {
    return sourceErr("malformed", "npm registry time.modified is not a string");
  }
  if (Number.isNaN(Date.parse(modified))) {
    return sourceErr("malformed", "npm registry time.modified is not a date");
  }
  return sourceOk({ version, time: modified, versions });
}
