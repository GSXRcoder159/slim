import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EXIT_FAIL, EXIT_USAGE, SlimExit } from "../exit.js";
export function fileBase(name) {
    return name.replace(/^@/, "").replace(/\//g, "-");
}
export function toPosixPath(p) {
    return p.replace(/\\/g, "/");
}
function existingAncestor(abs) {
    let dir = resolve(abs);
    while (!existsSync(dir)) {
        const parent = dirname(dir);
        if (parent === dir)
            return dir;
        dir = parent;
    }
    return dir;
}
function isEnoent(err) {
    return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}
function rootReal(root) {
    try {
        return realpathSync(existingAncestor(resolve(root)));
    }
    catch {
        return resolve(root);
    }
}
function symlinkDest(abs) {
    try {
        return realpathSync(abs);
    }
    catch {
        return resolve(dirname(abs), readlinkSync(abs));
    }
}
function pathExists(abs) {
    try {
        lstatSync(abs);
        return true;
    }
    catch (err) {
        if (isEnoent(err))
            return false;
        throw err;
    }
}
/** True when `candidate` is outside `root` (symlink-aware). */
export function pathEscapesRoot(root, candidate) {
    const absRoot = rootReal(root);
    const abs = resolve(candidate);
    let dest;
    try {
        dest = realpathSync(abs);
    }
    catch {
        const ancestor = existingAncestor(abs);
        let ancestorReal = ancestor;
        try {
            ancestorReal = realpathSync(ancestor);
        }
        catch {
            ancestorReal = resolve(ancestor);
        }
        dest = resolve(ancestorReal, relative(ancestor, abs));
    }
    const rel = relative(absRoot, dest);
    return rel.startsWith("..") || rel === ".." || isAbsolute(rel);
}
function posixRel(root, abs) {
    return relative(resolve(root), resolve(abs)).replace(/\\/g, "/") || ".";
}
function hopExit(kind) {
    return kind === "state" ? EXIT_FAIL : EXIT_USAGE;
}
function hopEscapeMessage(kind, absRoot, cur, target) {
    if (kind === "out")
        return `--out must stay inside the project root (got ${target})`;
    if (kind === "state")
        return `unsafe state path: ${posixRel(absRoot, cur)} escapes the project`;
    return `unsafe write: ${posixRel(absRoot, cur)} escapes the project`;
}
function hopSymlinkMessage(kind, absRoot, cur, target) {
    if (kind === "out")
        return `--out must not be a symlink (got ${target})`;
    if (kind === "state")
        return `unsafe state path: ${posixRel(absRoot, cur)} is a symlink`;
    return `unsafe write: ${posixRel(absRoot, cur)} is a symlink`;
}
/** Refuse any symlink hop from `target` up to (not including) `root`. */
function assertNoSymlinkHop(root, target, kind) {
    const absRoot = resolve(root);
    const abs = resolve(target);
    let cur = abs;
    while (cur !== absRoot && dirname(cur) !== cur) {
        let st;
        try {
            st = lstatSync(cur);
        }
        catch (err) {
            if (!isEnoent(err))
                throw err;
            cur = dirname(cur);
            continue;
        }
        if (st.isSymbolicLink()) {
            const dest = symlinkDest(cur);
            if (pathEscapesRoot(absRoot, dest)) {
                throw new SlimExit(hopExit(kind), hopEscapeMessage(kind, absRoot, cur, target));
            }
            throw new SlimExit(hopExit(kind), hopSymlinkMessage(kind, absRoot, cur, target));
        }
        cur = dirname(cur);
    }
}
/** Resolve target and require it to stay inside root (symlink-aware). */
export function assertInsideRoot(root, target) {
    const absRoot = resolve(root);
    const absTarget = resolve(absRoot, target);
    const rel = relative(rootReal(absRoot), realpathSync(existingAncestor(absTarget)));
    if (rel.startsWith("..") || rel === ".." || isAbsolute(rel)) {
        throw new SlimExit(EXIT_USAGE, `--out must stay inside the project root (got ${target})`);
    }
    const relFromRoot = relative(absRoot, absTarget);
    if (!(absTarget === absRoot || absTarget.startsWith(absRoot + sep))) {
        if (relFromRoot.startsWith("..") || isAbsolute(relFromRoot)) {
            throw new SlimExit(EXIT_USAGE, `--out must stay inside the project root (got ${target})`);
        }
    }
    assertNoSymlinkHop(absRoot, absTarget, "out");
    return absTarget;
}
/** Refuse escaping/symlinked/special state paths before a read or source conclusion. */
export function assertSafeStatePath(root, target) {
    const absRoot = resolve(root);
    const abs = resolve(target);
    if (pathEscapesRoot(absRoot, abs)) {
        throw new SlimExit(EXIT_FAIL, `unsafe state path: ${posixRel(absRoot, abs)} escapes the project`);
    }
    assertNoSymlinkHop(absRoot, abs, "state");
    let st;
    try {
        st = lstatSync(abs);
    }
    catch (err) {
        if (isEnoent(err))
            return;
        throw err;
    }
    if (st.isFIFO() || st.isSocket() || st.isCharacterDevice() || st.isBlockDevice()) {
        throw new SlimExit(EXIT_FAIL, `unsafe state path: ${posixRel(absRoot, abs)} is a special file`);
    }
    if (st.isDirectory()) {
        throw new SlimExit(EXIT_FAIL, `unsafe state path: ${posixRel(absRoot, abs)} is a directory`);
    }
}
/** Refuse escaping/internal symlinks, special files, and directory-as-file writes. */
export function assertSafeWrite(root, target) {
    const absRoot = resolve(root);
    const abs = resolve(target);
    if (pathEscapesRoot(absRoot, abs)) {
        throw new SlimExit(EXIT_USAGE, `unsafe write: ${posixRel(absRoot, abs)} escapes the project`);
    }
    assertNoSymlinkHop(absRoot, abs, "write");
    let st;
    try {
        st = lstatSync(abs);
    }
    catch (err) {
        if (isEnoent(err))
            return;
        throw err;
    }
    if (st.isFIFO() || st.isSocket() || st.isCharacterDevice() || st.isBlockDevice()) {
        throw new SlimExit(EXIT_FAIL, `unsafe write: ${posixRel(absRoot, abs)} is a special file`);
    }
    if (st.isDirectory()) {
        throw new SlimExit(EXIT_FAIL, `unsafe write: ${posixRel(absRoot, abs)} is a directory`);
    }
}
/** False when the path is missing, escaping, a symlink, special, or a directory. */
export function isSafeToRewrite(root, file) {
    try {
        lstatSync(resolve(file));
        assertSafeWrite(root, file);
        return true;
    }
    catch {
        return false;
    }
}
function loadManifest(root) {
    const manifestPath = join(root, ".slim", "manifest.json");
    if (!existsSync(manifestPath))
        return "missing";
    try {
        const man = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (man === null || typeof man !== "object" || Array.isArray(man))
            return "malformed";
        return man;
    }
    catch {
        return "malformed";
    }
}
function isAcceptedRecord(rec) {
    if (!rec)
        return false;
    return (typeof rec.version === "string" &&
        typeof rec.envelopeHash === "string" &&
        rec.envelopeHash.length === 64 &&
        Array.isArray(rec.symbols) &&
        rec.symbols.every((s) => typeof s === "string") &&
        typeof rec.module === "string");
}
function posixModule(module) {
    return module.replace(/\\/g, "/");
}
function ownsSlice(root, pkgName, sliceRel) {
    const man = loadManifest(root);
    if (man === "missing" || man === "malformed")
        return false;
    if (man.schemaVersion !== 1)
        return false;
    const own = man.replacements?.[pkgName];
    return isAcceptedRecord(own) && posixModule(own.module) === sliceRel;
}
export function assertNoOutputCollision(root, slimPath, pkgName) {
    if (!pathExists(slimPath))
        return;
    const rel = posixRel(root, slimPath);
    const man = loadManifest(root);
    if (man === "missing" || man === "malformed" || man.schemaVersion !== 1) {
        throw new SlimExit(EXIT_FAIL, `output collision: ${rel} exists and is not a Slim-owned module for ${pkgName}`);
    }
    const replacements = man.replacements;
    if (!replacements || typeof replacements !== "object" || Array.isArray(replacements)) {
        throw new SlimExit(EXIT_FAIL, `output collision: ${rel} exists and is not a Slim-owned module for ${pkgName}`);
    }
    for (const [name, rec] of Object.entries(replacements)) {
        if (name === pkgName)
            continue;
        const mod = typeof rec?.module === "string" ? posixModule(rec.module) : "";
        if (mod === rel) {
            throw new SlimExit(EXIT_FAIL, `output collision: ${rel} already belongs to ${name}, not ${pkgName}`);
        }
    }
    const own = replacements[pkgName];
    if (isAcceptedRecord(own) && posixModule(own.module) === rel)
        return;
    throw new SlimExit(EXIT_FAIL, `output collision: ${rel} exists and is not a Slim-owned module for ${pkgName}`);
}
/** Refuse symlink hops and unowned generated-output paths before mutation. */
export function assertGeneratedOutputSafe(root, slicePath, generatedPaths, pkgName) {
    const seen = new Set();
    for (const p of [slicePath, ...generatedPaths]) {
        const abs = resolve(p);
        if (seen.has(abs))
            continue;
        seen.add(abs);
        assertSafeWrite(root, abs);
    }
    assertNoOutputCollision(root, slicePath, pkgName);
    const sliceRel = posixRel(root, slicePath);
    for (const p of generatedPaths) {
        const abs = resolve(p);
        if (abs === resolve(slicePath))
            continue;
        if (!pathExists(abs))
            continue;
        if (!ownsSlice(root, pkgName, sliceRel)) {
            throw new SlimExit(EXIT_FAIL, `output collision: ${posixRel(root, abs)} exists and is not a Slim-owned module for ${pkgName}`);
        }
    }
}
//# sourceMappingURL=paths.js.map