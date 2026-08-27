import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertSafeWrite, pathEscapesRoot } from "./paths.ts";

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

function restore(path: string, snap: Snap): void {
  if (snap.kind === "absent") {
    try {
      unlinkPath(path);
    } catch {
      /* keep going */
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  try {
    unlinkPath(path);
  } catch {
    /* keep going */
  }
  if (snap.kind === "symlink") {
    symlinkSync(snap.target, path);
    return;
  }
  writeFileSync(path, snap.bytes);
  try {
    chmodSync(path, snap.mode);
  } catch {
    /* windows / unsupported mode */
  }
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
    if (this.originals.has(path)) return;
    assertSafeWrite(this.root, path);
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
      try {
        const real = realpathSync(path);
        if (real !== path && !pathEscapesRoot(this.root, real)) this.snapshot(real);
      } catch {
        /* dangling or loop */
      }
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
    for (const [path, snap] of [...this.originals].reverse()) {
      try {
        restore(path, snap);
      } catch {
        /* keep going */
      }
    }
    for (const dir of [...this.createdDirs].reverse()) {
      try {
        rmdirSync(dir);
      } catch {
        /* not empty or gone */
      }
    }
    this.originals.clear();
    this.createdDirs.length = 0;
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
