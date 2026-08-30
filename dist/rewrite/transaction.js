import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync, } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertSafeWrite } from "./paths.js";
function isEnoent(err) {
    return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}
function unlinkPath(path) {
    try {
        lstatSync(path);
    }
    catch (err) {
        if (isEnoent(err))
            return;
        throw err;
    }
    unlinkSync(path);
}
function restore(path, snap) {
    if (snap.kind === "absent") {
        try {
            unlinkPath(path);
        }
        catch {
            /* keep going */
        }
        return;
    }
    mkdirSync(dirname(path), { recursive: true });
    try {
        unlinkPath(path);
    }
    catch {
        /* keep going */
    }
    if (snap.kind === "symlink") {
        symlinkSync(snap.target, path);
        return;
    }
    writeFileSync(path, snap.bytes);
    try {
        chmodSync(path, snap.mode);
    }
    catch {
        /* windows / unsupported mode */
    }
}
/** Snapshot mutated paths; restore kind, bytes, and link target on rollback. First snapshot wins. */
export class MutationTxn {
    originals = new Map();
    createdDirs = [];
    committed = false;
    lockfileRefreshed = false;
    root;
    constructor(root) {
        this.root = root;
    }
    snapshot(absPath) {
        const path = resolve(absPath);
        if (this.originals.has(path))
            return;
        let st;
        try {
            st = lstatSync(path);
        }
        catch (err) {
            if (isEnoent(err)) {
                this.originals.set(path, { kind: "absent" });
                return;
            }
            throw err;
        }
        if (st.isSymbolicLink()) {
            this.originals.set(path, { kind: "symlink", target: readlinkSync(path) });
            return;
        }
        if (st.isFile()) {
            this.originals.set(path, { kind: "file", bytes: readFileSync(path), mode: st.mode });
            return;
        }
        assertSafeWrite(this.root, path);
    }
    /** Snapshot path (first wins) and mkdir parents that do not yet exist. */
    prepareWrite(absPath) {
        const path = resolve(absPath);
        assertSafeWrite(this.root, path);
        this.snapshot(path);
        const dirs = [];
        let dir = dirname(path);
        const root = resolve(this.root);
        while (dir.startsWith(root + sep) || dir === root) {
            let present = false;
            try {
                lstatSync(dir);
                present = true;
            }
            catch (err) {
                if (!isEnoent(err))
                    throw err;
            }
            if (present)
                break;
            dirs.unshift(dir);
            if (dir === root)
                break;
            dir = dirname(dir);
        }
        for (const d of dirs) {
            mkdirSync(d, { recursive: true });
            this.createdDirs.push(d);
        }
    }
    writeFile(absPath, data) {
        this.prepareWrite(absPath);
        writeFileSync(absPath, data);
    }
    /** Project-relative POSIX paths snapshotted in this transaction. Empty after commit/rollback. */
    mutatedPaths() {
        const root = resolve(this.root);
        return [...this.originals.keys()].map((p) => relative(root, p).replace(/\\/g, "/"));
    }
    commit() {
        this.committed = true;
        this.originals.clear();
        this.createdDirs.length = 0;
        this.lockfileRefreshed = false;
    }
    rollback() {
        if (this.committed)
            return;
        for (const [path, snap] of [...this.originals].reverse()) {
            try {
                restore(path, snap);
            }
            catch {
                /* keep going */
            }
        }
        for (const dir of [...this.createdDirs].reverse()) {
            try {
                rmdirSync(dir);
            }
            catch {
                /* not empty or gone */
            }
        }
        this.originals.clear();
        this.createdDirs.length = 0;
    }
}
export function lockfilePath(root, kind) {
    if (kind === "pnpm")
        return join(root, "pnpm-lock.yaml");
    if (kind === "yarn")
        return join(root, "yarn.lock");
    if (kind === "bun") {
        const text = join(root, "bun.lock");
        if (existsSync(text))
            return text;
        return join(root, "bun.lockb");
    }
    if (kind === "npm")
        return join(root, "package-lock.json");
    return null;
}
//# sourceMappingURL=transaction.js.map