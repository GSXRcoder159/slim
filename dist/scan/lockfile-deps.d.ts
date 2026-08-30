import type { Project } from "../project.ts";
export type LockfileFileState = "ok" | "malformed" | "unavailable" | "absent";
export interface LockfileResult {
    state: LockfileFileState;
    reason: string;
    versions: Map<string, string>;
}
/** Direct dependency name → exact lockfile version, plus parse honesty. */
export declare function lockfileDirectDeps(root: string, kind: Project["lockfile"]): LockfileResult;
