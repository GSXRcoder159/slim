import { realpathSync, existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, dirname, join } from "node:path";
import { resolvePackageFamily } from "./family.js";
export function scriptKind(ts, file) {
    if (file.endsWith(".tsx"))
        return ts.ScriptKind.TSX;
    if (file.endsWith(".jsx"))
        return ts.ScriptKind.JSX;
    if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) {
        return ts.ScriptKind.JS;
    }
    return ts.ScriptKind.TS;
}
export function locOf(sf, node, root) {
    const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const end = sf.getLineAndCharacterOfPosition(node.getEnd());
    return {
        file: toProjectRel(sf.fileName, root),
        line: start.line + 1,
        column: start.character + 1,
        endLine: end.line + 1,
        endColumn: end.character + 1,
    };
}
export function uid(prefix, sf, node, root) {
    return `${prefix}:${toProjectRel(sf.fileName, root)}:${node.getStart(sf)}`;
}
export function toProjectRel(file, root) {
    const posix = (p) => p.split(sep).join("/");
    const relOf = (from, to) => {
        const rel = relative(from, to);
        if (rel.startsWith("..") || isAbsolute(rel))
            return null;
        return posix(rel);
    };
    const absFile = isAbsolute(file) ? file : resolve(root, file);
    const absRoot = resolve(root);
    let hit = relOf(absRoot, absFile);
    if (hit)
        return hit;
    try {
        hit = relOf(realpathSync(absRoot), realpathSync(absFile));
        if (hit)
            return hit;
    }
    catch {
        /* ignore */
    }
    const rootPosix = posix(absRoot).replace(/\/$/, "");
    const filePosix = posix(absFile);
    if (filePosix.startsWith(rootPosix + "/"))
        return filePosix.slice(rootPosix.length + 1);
    return posix(absFile);
}
export function normPath(p) {
    try {
        return realpathSync(p);
    }
    catch {
        return p;
    }
}
export function exportNameOf(b) {
    if (b.imported !== "*" && b.imported !== "default")
        return b.imported;
    const fam = resolvePackageFamily(b.specifier);
    if (fam?.subpath)
        return fam.subpath.split("/")[0];
    return b.imported === "default" ? "default" : "*";
}
export function resolveRelative(fromFile, spec) {
    const dir = dirname(fromFile);
    const base = join(dir, spec);
    const candidates = [
        base,
        base + ".ts",
        base + ".js",
        base + ".tsx",
        base + ".mjs",
        base + ".cjs",
        join(base, "index.ts"),
        join(base, "index.js"),
    ];
    return candidates.find((c) => existsSync(c)) ?? null;
}
//# sourceMappingURL=model.js.map