import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { EXIT_FAIL, SlimExit } from "./exit.js";
import { assertDocument } from "./schema/documents.js";
export const DEFAULT_CONFIG = {
    outDir: "src/slim",
    budgetMs: process.env.CI ? 300_000 : 30_000,
    testCommand: null,
    include: [],
    ignore: [],
    replacements: {},
};
export function loadConfig(projectRoot) {
    const path = ["slim.json", "slim.config.json"]
        .map((f) => join(projectRoot, f))
        .find((p) => existsSync(p));
    if (!path)
        return { ...DEFAULT_CONFIG, replacements: {} };
    let raw;
    try {
        raw = JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        throw new SlimExit(EXIT_FAIL, `malformed ${basename(path)}`);
    }
    assertDocument("slim", raw, basename(path));
    return {
        outDir: raw.outDir ?? DEFAULT_CONFIG.outDir,
        budgetMs: raw.budgetMs ?? DEFAULT_CONFIG.budgetMs,
        testCommand: raw.testCommand ?? null,
        include: raw.include ?? [],
        ignore: raw.ignore ?? [],
        replacements: raw.replacements ?? {},
    };
}
//# sourceMappingURL=config.js.map