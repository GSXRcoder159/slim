import { type ExecFileSyncOptions, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import type { Project } from "../project.ts";
/** `--no-install` skips lockfile refresh only. `--keep-original` skips uninstall+install. */
export declare function shouldRefreshLockfile(opts: {
    keepOriginal?: boolean;
    noInstall?: boolean;
}): boolean;
type ExecFile = (file: string, args: readonly string[], opts?: {
    cwd?: string;
    encoding?: BufferEncoding;
    stdio?: string | string[];
    env?: NodeJS.ProcessEnv;
    shell?: boolean;
    windowsHide?: boolean;
}) => unknown;
/**
 * Windows `.cmd`/`.bat` shims are not PE images. CreateProcess cannot launch them;
 * cmd.exe (`shell: true`) must. `bun` is a real `.exe` and stays unshimmed.
 */
export declare function cmdShim(name: string): string;
export declare function cmdShimSpawnOpts(bin: string): {
    shell?: boolean;
    windowsHide?: boolean;
};
/** Package scripts and node_modules/.bin shims need cmd.exe; node.exe does not. */
export declare function scriptSpawnOpts(file: string): {
    shell?: boolean;
    windowsHide?: boolean;
};
export declare function spawnPm(name: string, args: readonly string[], opts?: SpawnSyncOptions): SpawnSyncReturns<string | Buffer>;
/** `node` in package.json scripts is node.exe; resolve it so Windows cmd.exe is not required. */
export declare function resolveScriptFile(file: string): string;
export declare function execPm(name: string, args: readonly string[], opts?: ExecFileSyncOptions): string | Buffer;
/** Install must update the lockfile after package.json edits; CI frozen-lockfile would fail closed incorrectly. */
export declare function hermeticPmEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function installCommandFor(lockfile: Project["lockfile"]): string;
export declare function refreshLockfile(project: Project, opts?: {
    keepOriginal?: boolean;
    noInstall?: boolean;
    frozen?: boolean;
}, execFile?: ExecFile): void;
export {};
