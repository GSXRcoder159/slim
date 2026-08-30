/**
 * MIT License
 *
 * npm tarball identity: SHA-256 of packed member paths + bytes, not tar headers.
 * Action digest matches action/digest.mjs (wrappers + dist except the stamp).
 */
export declare const STAMP_NAME = ".slim-build.json";
export declare const ACTION_WRAPPERS: readonly ["action/check/action.yml", "action/bloat/action.yml", "action/upstream/action.yml", "action/run.mjs", "action/digest.mjs"];
/** Extract `package/` from an npm tarball into dest. Returns the package root. */
export declare function extractNpmPack(tarball: string, dest: string): string;
export declare function contentDigestOfDir(root: string): string;
export declare function npmContentDigest(tarball: string): string;
export declare function actionDigestFromPack(packageRoot: string): string;
export declare function stampActionSha256(packageRoot: string): string | null;
export declare function stampDistSha256(packageRoot: string): string | null;
export declare function readStamp(packageRoot: string): {
    sha256?: string;
    actionSha256?: string;
} | null;
export interface ArtifactIdentity {
    schemaVersion: 1;
    commit: string;
    npmDigest: string;
    actionDigest: string;
    distSha256: string;
    packedAt: string;
}
export declare function artifactIdentity(opts: {
    commit: string;
    npmDigest: string;
    actionDigest: string;
    distSha256: string;
    packedAt?: string;
}): ArtifactIdentity;
