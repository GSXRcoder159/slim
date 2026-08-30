/**
 * MIT License
 *
 * SHA-256 identities for replacement artifacts bound into evidence.json.
 */
export interface ArtifactDigests {
    moduleDigest: string;
    standingDigest: string;
    hardeningDigest: string;
    oracleVersion: string;
    fixtureRevision: string;
}
export declare function sha256Bytes(buf: Buffer | string): string;
export declare function sha256File(path: string): string;
export declare function fixtureRevision(standing: Buffer, hardening: Buffer): string;
export declare function standingSuiteBytes(root: string, pkg: string, outDir: string): Buffer | null;
export declare function hardeningSuiteBytes(root: string, moduleRel: string): Buffer | null;
export declare function artifactDigests(opts: {
    root: string;
    pkg: string;
    outDir: string;
    moduleRel: string;
    oracleVersion: string;
    moduleSource?: string | Buffer;
}): ArtifactDigests;
