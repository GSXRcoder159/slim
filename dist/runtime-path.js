import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Resolve a sibling module next to the compiled or source caller.
 * Prefers `.js` (packed/dist) and falls back to `.ts` (repo source).
 */
export function siblingModule(metaUrl, relNoExt) {
    const dir = dirname(fileURLToPath(metaUrl));
    const js = join(dir, `${relNoExt}.js`);
    const ts = join(dir, `${relNoExt}.ts`);
    if (existsSync(js))
        return js;
    if (existsSync(ts))
        return ts;
    throw new Error(`slim runtime file missing: ${relNoExt} (.js/.ts) next to ${dir}`);
}
//# sourceMappingURL=runtime-path.js.map