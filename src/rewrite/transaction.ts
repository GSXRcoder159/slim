import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { EXIT_USAGE, SlimExit } from "../exit.ts";
import { pathEscapesRoot, assertSafeWrite } from "./paths.ts";

type Snap =
  | { kind: "absent" }
  | { kind: "file"; bytes: Buffer; mode: number }
  | { kind: "symlink"; target: string };

function isEnoent(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT");
}

function unlinkPath(path: string): void {
  try {
    lstatSync(path);
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
  unlinkSync(path);
}

function assertTxnPath(root: string, path: string): void {
  if (pathEscapesRoot(root, path)) {
    throw new SlimExit(EXIT_USAGE, `unsafe transaction path escapes the project: ${path}`);
  }
}

function verify(path: string, snap: Snap): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if (isEnoent(err) && snap.kind === "absent") return;
    throw err;
  }
  if (snap.kind === "absent") throw new Error(`rollback left path in place: ${path}`);
  if (snap.kind === "symlink") {
    if (!st.isSymbolicLink() || readlinkSync(path) !== snap.target) {
      throw new Error(`rollback did not restore symlink: ${path}`);
    }
    return;
  }
  if (
    !st.isFile() ||
    !readFileSync(path).equals(snap.bytes) ||
    (process.platform !== "win32" && (st.mode & 0o7777) !== (snap.mode & 0o7777))
  ) {
    throw new Error(`rollback did not restore file: ${path}`);
  }
}

function restore(path: string, snap: Snap): void {
  if (snap.kind === "absent") {
    try {
      unlinkPath(path);
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    verify(path, snap);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  try {
    unlinkPath(path);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  if (snap.kind === "symlink") {
    symlinkSync(snap.target, path);
    verify(path, snap);
    return;
  }
  writeFileSync(path, snap.bytes);
  try {
    chmodSync(path, snap.mode);
  } catch {
    // Windows may not preserve POSIX mode bits.
  }
  verify(path, snap);
}

/** Snapshot mutated paths; restore kind, bytes, and link target on rollback. First snapshot wins. */
export class MutationTxn {
  private originals = new Map<string, Snap>();
  private createdDirs: string[] = [];
  private committed = false;
  lockfileRefreshed = false;

  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  snapshot(absPath: string): void {
    const path = resolve(absPath);
    assertTxnPath(this.root, path);
    if (this.originals.has(path)) return;
    let st;
    try {
      st = lstatSync(path);
    } catch (err) {
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
  prepareWrite(absPath: string): void {
    const path = resolve(absPath);
    assertSafeWrite(this.root, path);
    this.snapshot(path);
    const dirs: string[] = [];
    let dir = dirname(path);
    const root = resolve(this.root);
    while (dir.startsWith(root + sep) || dir === root) {
      let present = false;
      try {
        lstatSync(dir);
        present = true;
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
      if (present) break;
      dirs.unshift(dir);
      if (dir === root) break;
      dir = dirname(dir);
    }
    for (const d of dirs) {
      mkdirSync(d, { recursive: true });
      this.createdDirs.push(d);
    }
  }

  writeFile(absPath: string, data: string | Buffer): void {
    this.prepareWrite(absPath);
    writeFileSync(absPath, data);
  }

  /** Project-relative POSIX paths snapshotted in this transaction. Empty after commit/rollback. */
  mutatedPaths(): string[] {
    const root = resolve(this.root);
    return [...this.originals.keys()].map((p) => relative(root, p).replace(/\\/g, "/"));
  }

  commit(): void {
    this.committed = true;
    this.originals.clear();
    this.createdDirs.length = 0;
    this.lockfileRefreshed = false;
  }

  rollback(): void {
    if (this.committed) return;
    const failures: unknown[] = [];
    for (const [path, snap] of [...this.originals].reverse()) {
      try {
        assertTxnPath(this.root, path);
        restore(path, snap);
      } catch (err) {
        failures.push(err);
      }
    }
    for (const dir of [...this.createdDirs].reverse()) {
      try {
        rmdirSync(dir);
      } catch (err) {
        if (!isEnoent(err)) failures.push(err);
      }
    }
    this.originals.clear();
    this.createdDirs.length = 0;
    if (failures.length) {
      throw new Error(`transaction rollback failed: ${failures.map((e) => String(e)).join("; ")}`);
    }
  }
}

export function lockfilePath(root: string, kind: "npm" | "pnpm" | "yarn" | "bun" | null): string | null {
  if (kind === "pnpm") return join(root, "pnpm-lock.yaml");
  if (kind === "yarn") return join(root, "yarn.lock");
  if (kind === "bun") {
    const text = join(root, "bun.lock");
    if (existsSync(text)) return text;
    return join(root, "bun.lockb");
  }
  if (kind === "npm") return join(root, "package-lock.json");
  return null;
}
