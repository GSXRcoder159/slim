/**
 * MIT License
 *
 * Fail when a production dependency is a known fat package without a Slim replacement.
 */
import { BLOAT_PACKAGES } from "./scan/refuse.js";
import { loadConfig } from "./config.js";
import { loadProject } from "./project.js";
import { resolvePackageFamily } from "./analyze/family.js";
import { EXIT_FAIL, EXIT_OK } from "./exit.js";
/** Production direct deps in BLOAT_PACKAGES that have no Slim replacement. Ignores devDependencies and import sites. */
export function runBloatCheck(cwd = process.cwd()) {
    const project = loadProject(cwd);
    const config = loadConfig(project.root);
    const replaced = new Set(Object.keys(config.replacements));
    const deps = project.packageJson.dependencies ?? {};
    const bad = Object.keys(deps).filter((name) => {
        if (!BLOAT_PACKAGES.has(name))
            return false;
        const fam = resolvePackageFamily(name);
        return !replaced.has(name) && !(fam && replaced.has(fam.family));
    });
    if (bad.length) {
        process.stderr.write("slim-bloat: fat/Edge-hostile package without a Slim replacement:\n" +
            bad.map((name) => `  ${name} (production dependency)`).join("\n") +
            "\n");
        return EXIT_FAIL;
    }
    process.stdout.write("slim-bloat: ok\n");
    return EXIT_OK;
}
//# sourceMappingURL=bloat.js.map