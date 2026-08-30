export declare function fileBase(name: string): string;
export declare function toPosixPath(p: string): string;
/** True when `candidate` is outside `root` (symlink-aware). */
export declare function pathEscapesRoot(root: string, candidate: string): boolean;
/** Resolve target and require it to stay inside root (symlink-aware). */
export declare function assertInsideRoot(root: string, target: string): string;
/** Refuse escaping/symlinked/special state paths before a read or source conclusion. */
export declare function assertSafeStatePath(root: string, target: string): void;
/** Refuse escaping/internal symlinks, special files, and directory-as-file writes. */
export declare function assertSafeWrite(root: string, target: string): void;
/** False when the path is missing, escaping, a symlink, special, or a directory. */
export declare function isSafeToRewrite(root: string, file: string): boolean;
export declare function assertNoOutputCollision(root: string, slimPath: string, pkgName: string): void;
/** Refuse symlink hops and unowned generated-output paths before mutation. */
export declare function assertGeneratedOutputSafe(root: string, slicePath: string, generatedPaths: string[], pkgName: string): void;
