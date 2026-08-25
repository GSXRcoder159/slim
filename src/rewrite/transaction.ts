import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** Snapshot mutated paths; restore or unlink on rollback. First snapshot wins. */
export class MutationTxn {
  private originals = new Map<string, Buffer | null>();
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
    this.originals.set(path, existsSync(path) && lstatSync(path).isFile() ? readFileSync(path) : null);
  }

  /** Snapshot path (first wins) and mkdir parents that do not yet exist. */
  prepareWrite(absPath: string): void {
    const path = resolve(absPath);
    this.snapshot(path);
    const dirs: string[] = [];
    let dir = dirname(path);
    const root = resolve(this.root);
    while (dir.startsWith(root + sep) || dir === root) {
      if (existsSync(dir)) break;
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

  commit(): void {
    this.committed = true;
    this.originals.clear();
    this.createdDirs.length = 0;
    this.lockfileRefreshed = false;
  }

  rollback(): void {
    if (this.committed) return;
    for (const [path, buf] of this.originals) {
      if (buf === null) {
        try {
          if (existsSync(path)) unlinkSync(path);
        } catch {
          /* keep going */
        }
      } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, buf);
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
