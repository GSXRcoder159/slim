import { existsSync } from "node:fs";
/**
 * Generator must never ingest original implementation files.
 * .d.ts and README are API specs; .js under node_modules is not.
 */
export declare class OriginalSourceGuard {
    static assertNotOriginalImpl(filePath: string): void;
    static readPublicSpec(filePath: string): string;
}
/** Refuse metadata that is absolute or that resolves outside `allowedRoot`. */
export declare function assertDeclaredSpecInside(allowedRoot: string, rel: string): string;
/** Refuse symlink/traversal that leaves `allowedRoot`. `candidate` may already be absolute. */
export declare function assertPublicSpecInside(allowedRoot: string, candidate: string): string;
/** Generate/validate file reads. Fuzz workers may still import originals. */
export declare function guardedReadFileSync(filePath: string): string;
export declare function slimRoot(): string;
export declare function catalogRoot(): string;
export { existsSync };
