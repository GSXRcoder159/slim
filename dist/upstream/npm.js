import { fetchJson, sourceErr, sourceOk } from "./status.js";
export async function npmLatest(name, fetchImpl = fetch) {
    const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
    const got = await fetchJson(url, {}, fetchImpl);
    if (got.status !== "success") {
        return { status: got.status, detail: `npm registry ${got.detail}` };
    }
    const json = got.value;
    if (!json || typeof json !== "object" || Array.isArray(json)) {
        return sourceErr("malformed", "npm registry body is not an object");
    }
    const rec = json;
    const version = typeof rec["dist-tags"]?.latest === "string"
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
    const versions = Object.keys(rec.versions);
    if (!versions.includes(version)) {
        return sourceErr("malformed", "npm latest missing from versions");
    }
    if (!rec.time || typeof rec.time !== "object" || Array.isArray(rec.time)) {
        return sourceErr("malformed", "npm registry time is not an object");
    }
    const modified = rec.time.modified;
    if (typeof modified !== "string" || !modified) {
        return sourceErr("malformed", "npm registry time.modified is not a string");
    }
    if (Number.isNaN(Date.parse(modified))) {
        return sourceErr("malformed", "npm registry time.modified is not a date");
    }
    return sourceOk({ version, time: modified, versions });
}
//# sourceMappingURL=npm.js.map