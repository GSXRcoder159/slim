import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileBase, toPosixPath } from "../rewrite/paths.js";
export function standingTestPaths(root, pkg, outDir) {
    const stem = `${fileBase(pkg)}.test`;
    const tsRel = toPosixPath(join(outDir, `${stem}.ts`));
    const jsRel = toPosixPath(join(outDir, `${stem}.js`));
    return { tsRel, jsRel, tsAbs: join(root, tsRel), jsAbs: join(root, jsRel) };
}
export function hardeningTestPaths(root, moduleRel) {
    const base = moduleRel.replace(/\.(ts|js|mjs|cjs)$/, "");
    const tsRel = toPosixPath(`${base}.hardened.test.ts`);
    const jsRel = toPosixPath(`${base}.hardened.test.js`);
    return { tsRel, jsRel, tsAbs: join(root, tsRel), jsAbs: join(root, jsRel) };
}
export function evidenceScript(root) {
    const pkgPath = join(root, "package.json");
    if (!existsSync(pkgPath))
        return null;
    try {
        const json = JSON.parse(readFileSync(pkgPath, "utf8"));
        return json.scripts?.["slim:evidence"]?.trim() || null;
    }
    catch {
        return null;
    }
}
export function hasStandingTests(root, pkg, outDir) {
    if (evidenceScript(root))
        return true;
    const paths = standingTestPaths(root, pkg, outDir);
    return existsSync(paths.tsAbs) || existsSync(paths.jsAbs);
}
//# sourceMappingURL=paths.js.map