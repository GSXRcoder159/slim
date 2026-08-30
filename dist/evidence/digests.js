/**
 * MIT License
 *
 * SHA-256 identities for replacement artifacts bound into evidence.json.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_FAIL, SlimExit } from "../exit.js";
import { evidenceScript, hardeningTestPaths, standingTestPaths } from "./paths.js";
export function sha256Bytes(buf) {
    return createHash("sha256").update(buf).digest("hex");
}
export function sha256File(path) {
    return sha256Bytes(readFileSync(path));
}
export function fixtureRevision(standing, hardening) {
    return sha256Bytes(Buffer.concat([standing, Buffer.from([0]), hardening]));
}
export function standingSuiteBytes(root, pkg, outDir) {
    const script = evidenceScript(root);
    if (script)
        return Buffer.from(script, "utf8");
    const paths = standingTestPaths(root, pkg, outDir);
    if (existsSync(paths.tsAbs))
        return readFileSync(paths.tsAbs);
    if (existsSync(paths.jsAbs))
        return readFileSync(paths.jsAbs);
    return null;
}
export function hardeningSuiteBytes(root, moduleRel) {
    const paths = hardeningTestPaths(root, moduleRel);
    if (existsSync(paths.tsAbs))
        return readFileSync(paths.tsAbs);
    if (existsSync(paths.jsAbs))
        return readFileSync(paths.jsAbs);
    return null;
}
export function artifactDigests(opts) {
    const moduleAbs = join(opts.root, opts.moduleRel);
    const moduleBuf = opts.moduleSource !== undefined
        ? Buffer.isBuffer(opts.moduleSource)
            ? opts.moduleSource
            : Buffer.from(opts.moduleSource)
        : existsSync(moduleAbs)
            ? readFileSync(moduleAbs)
            : null;
    const standing = standingSuiteBytes(opts.root, opts.pkg, opts.outDir);
    const hardening = hardeningSuiteBytes(opts.root, opts.moduleRel);
    if (!moduleBuf) {
        throw new SlimExit(EXIT_FAIL, `missing slice module ${opts.moduleRel}`);
    }
    if (!standing) {
        throw new SlimExit(EXIT_FAIL, `missing standing tests for ${opts.pkg}`);
    }
    if (!hardening) {
        throw new SlimExit(EXIT_FAIL, `missing hardening tests for ${opts.moduleRel}`);
    }
    return {
        moduleDigest: sha256Bytes(moduleBuf),
        standingDigest: sha256Bytes(standing),
        hardeningDigest: sha256Bytes(hardening),
        oracleVersion: opts.oracleVersion,
        fixtureRevision: fixtureRevision(standing, hardening),
    };
}
//# sourceMappingURL=digests.js.map