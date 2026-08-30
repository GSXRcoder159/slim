/** Snapshot mutated paths; restore kind, bytes, and link target on rollback. First snapshot wins. */
export declare class MutationTxn {
    private originals;
    private createdDirs;
    private committed;
    lockfileRefreshed: boolean;
    readonly root: string;
    constructor(root: string);
    snapshot(absPath: string): void;
    /** Snapshot path (first wins) and mkdir parents that do not yet exist. */
    prepareWrite(absPath: string): void;
    writeFile(absPath: string, data: string | Buffer): void;
    /** Project-relative POSIX paths snapshotted in this transaction. Empty after commit/rollback. */
    mutatedPaths(): string[];
    commit(): void;
    rollback(): void;
}
export declare function lockfilePath(root: string, kind: "npm" | "pnpm" | "yarn" | "bun" | null): string | null;
