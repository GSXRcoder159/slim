import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
function empty(state, reason) {
    return { state, reason, versions: new Map() };
}
function ok(versions) {
    return { state: "ok", reason: "", versions };
}
/** Direct dependency name → exact lockfile version, plus parse honesty. */
export function lockfileDirectDeps(root, kind) {
    if (kind === "npm")
        return parseNpmLock(join(root, "package-lock.json"));
    if (kind === "pnpm")
        return parsePnpmLock(join(root, "pnpm-lock.yaml"));
    if (kind === "yarn")
        return parseYarnLock(join(root, "yarn.lock"));
    if (kind === "bun") {
        const text = join(root, "bun.lock");
        const bin = join(root, "bun.lockb");
        if (existsSync(text))
            return parseBunLock(text);
        if (existsSync(bin)) {
            return empty("unavailable", "binary bun.lockb is not parsed; add a text bun.lock");
        }
        return empty("absent", "no bun.lock");
    }
    return empty("absent", "no lockfile");
}
function parseNpmLock(path) {
    const versions = new Map();
    if (!existsSync(path))
        return empty("absent", "package-lock.json missing");
    let json;
    try {
        json = JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return empty("malformed", "package-lock.json is not valid JSON");
    }
    const pkgs = json.packages;
    if (pkgs) {
        const root = pkgs[""];
        const direct = {
            ...(root?.dependencies ?? {}),
            ...(root?.optionalDependencies ?? {}),
        };
        for (const name of Object.keys(direct)) {
            const rec = pkgs[`node_modules/${name}`];
            if (rec?.version)
                versions.set(name, rec.version);
        }
        return ok(versions);
    }
    if (json.dependencies) {
        for (const [name, rec] of Object.entries(json.dependencies)) {
            if (rec?.version)
                versions.set(name, rec.version);
        }
        return ok(versions);
    }
    if (json.lockfileVersion != null)
        return ok(versions);
    return empty("malformed", "package-lock.json has no packages or dependencies");
}
function parsePnpmLock(path) {
    const versions = new Map();
    if (!existsSync(path))
        return empty("absent", "pnpm-lock.yaml missing");
    const text = readFileSync(path, "utf8");
    if (!/lockfileVersion\s*:/.test(text) && !/(?:^|\n)importers\s*:/.test(text)) {
        return empty("malformed", "pnpm-lock.yaml is missing lockfileVersion and importers");
    }
    const importer = text.match(/(?:^|\n)importers:\n {2}\.:\n([\s\S]*?)(?=\n(?:packages|snapshots|time|overrides):|\n[^\s]|$)/);
    const block = importer?.[1] ?? "";
    const depSection = block.match(/(?:^|\n) {4}(?:dependencies|optionalDependencies):\n([\s\S]*?)(?=\n {4}\w|\n {2}\S|$)/g);
    if (depSection) {
        for (const sec of depSection) {
            const re = /(?:^|\n) {6}(\S+):\n(?: {8}.*\n)*? {8}version: ['"]?([^'"\n ]+)/g;
            let m;
            while ((m = re.exec(sec))) {
                versions.set(m[1], stripPnpmPeer(m[2]));
            }
        }
    }
    if (versions.size)
        return ok(versions);
    const names = new Set();
    const specRe = /\n {6}(@?[\w.-]+(?:\/[\w.-]+)?):\n {8}specifier:/g;
    let sm;
    const head = text.slice(0, 8000);
    while ((sm = specRe.exec(head)))
        names.add(sm[1]);
    const pkgRe = /\n {2}(?:['"]?)(?:\/)?(@?[\w.-]+(?:\/[\w.-]+)?)@([^'"\s:(]+)/g;
    let pm;
    while ((pm = pkgRe.exec(text))) {
        const name = pm[1];
        if (names.size === 0 || names.has(name))
            versions.set(name, stripPnpmPeer(pm[2]));
    }
    return ok(versions);
}
function stripPnpmPeer(v) {
    return v.replace(/\(.+$/, "").replace(/^['"]|['"]$/g, "");
}
function yarnDescriptorName(line) {
    const trimmed = line.trim().replace(/^"+|"+\s*:?\s*$/g, "");
    const first = trimmed.split(",")[0].trim().replace(/^"+|"+$/g, "");
    if (!first || first.startsWith("__") || first.startsWith("#"))
        return null;
    const at = first.startsWith("@") ? first.indexOf("@", 1) : first.indexOf("@");
    if (at <= 0)
        return null;
    return first.slice(0, at);
}
function parseYarnLock(path) {
    const versions = new Map();
    if (!existsSync(path))
        return empty("absent", "yarn.lock missing");
    const text = readFileSync(path, "utf8");
    const classic = /(?:^|\n)# yarn lockfile v/i.test(text);
    const berry = /(?:^|\n)__metadata\s*:/.test(text);
    const blocks = text.split(/\n(?=\S)/);
    for (const block of blocks) {
        const keyLine = block.match(/^[^\n]+/)?.[0] ?? "";
        const name = yarnDescriptorName(keyLine);
        const ver = block.match(/\n {2}version:? "?([^"\n]+)"?/);
        if (name && ver)
            versions.set(name, ver[1].trim());
    }
    if (!classic && !berry && versions.size === 0 && text.trim().length > 0) {
        return empty("malformed", "yarn.lock is not a recognized classic or berry lockfile");
    }
    return ok(versions);
}
function stripJsonComments(text) {
    let out = "";
    let i = 0;
    let inStr = false;
    let escape = false;
    while (i < text.length) {
        const c = text[i];
        if (inStr) {
            out += c;
            if (escape)
                escape = false;
            else if (c === "\\")
                escape = true;
            else if (c === '"')
                inStr = false;
            i++;
            continue;
        }
        if (c === '"') {
            inStr = true;
            out += c;
            i++;
            continue;
        }
        if (c === "/" && text[i + 1] === "/") {
            while (i < text.length && text[i] !== "\n")
                i++;
            continue;
        }
        if (c === "/" && text[i + 1] === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/"))
                i++;
            i += 2;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}
function parseBunLock(path) {
    const versions = new Map();
    if (!existsSync(path))
        return empty("absent", "bun.lock missing");
    let text;
    try {
        text = readFileSync(path, "utf8");
    }
    catch {
        return empty("unavailable", "bun.lock could not be read");
    }
    if (/[\u0000-\u0008]/.test(text)) {
        return empty("unavailable", "binary bun.lockb is not parsed; add a text bun.lock");
    }
    try {
        const json = JSON.parse(stripJsonComments(text));
        if (json.packages && typeof json.packages === "object") {
            for (const [name, rec] of Object.entries(json.packages)) {
                if (name.includes("/") && !name.startsWith("@"))
                    continue;
                const ver = bunVersion(rec);
                if (!ver)
                    continue;
                versions.set(name, ver);
            }
        }
        if (versions.size || json.packages)
            return ok(versions);
    }
    catch {
        const re = /"(@?[\w.-]+(?:\/[\w.-]+)?)"\s*:\s*\[\s*"\1@([^"]+)"/g;
        let m;
        while ((m = re.exec(text)))
            versions.set(m[1], m[2]);
        if (versions.size)
            return ok(versions);
        return empty("malformed", "bun.lock is not valid JSON");
    }
    return empty("malformed", "bun.lock has no packages table");
}
function bunVersion(rec) {
    if (Array.isArray(rec) && typeof rec[0] === "string") {
        const m = rec[0].match(/@([^@]+)$/);
        return m?.[1];
    }
    if (rec && typeof rec === "object" && "version" in rec && typeof rec.version === "string") {
        return rec.version;
    }
    return undefined;
}
//# sourceMappingURL=lockfile-deps.js.map