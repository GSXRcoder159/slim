import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_OK, EXIT_USAGE, SlimExit } from "./exit.js";
import { loadProject } from "./project.js";
import { loadConfig } from "./config.js";
import { analyzePackage } from "./analyze/index.js";
import { hashEnvelope, envelopeForDisk } from "./envelope/types.js";
import { assertDocument } from "./schema/documents.js";
import { JSON_SCHEMA_VERSION } from "./json.js";
import { refusePackage, formatRefuse } from "./scan/refuse.js";
import { EXIT_REFUSED } from "./exit.js";
export async function runInspect(args) {
    if (!args.pkg) {
        throw new SlimExit(EXIT_USAGE, "usage: slim inspect <pkg>");
    }
    const project = loadProject();
    const config = loadConfig(project.root);
    const installed = join(project.root, "node_modules", args.pkg);
    const refuse = refusePackage(args.pkg, existsSync(installed) ? installed : null);
    const env = analyzePackage(project, args.pkg, {
        allowUnknown: args.allowUnknown,
        include: config.include,
        ignore: config.ignore,
    });
    const dir = join(project.root, ".slim", env.package.name);
    mkdirSync(dir, { recursive: true });
    const disk = envelopeForDisk(env);
    assertDocument("envelope", disk);
    writeFileSync(join(dir, "envelope.json"), JSON.stringify(disk, null, 2) + "\n");
    const decision = env.closure.readyToGenerate ? "try" : "refuse";
    if (args.json) {
        const doc = {
            schemaVersion: JSON_SCHEMA_VERSION,
            envelope: disk,
            hash: hashEnvelope(env),
            decision,
            reason: env.closure.reason,
        };
        assertDocument("inspect", doc);
        process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
    }
    else {
        process.stdout.write(`package     ${env.package.name}@${env.package.version}  family=${env.package.family}\n`);
        process.stdout.write(`confidence  ${env.closure.confidence}  ready=${env.closure.readyToGenerate}\n`);
        process.stdout.write(`slimmable   ${env.slimmable.verdict}  score=${env.slimmable.score}\n`);
        process.stdout.write(`symbols     ${env.symbols.map((s) => s.exportName).join(", ") || "(none)"}\n`);
        process.stdout.write(`imports     ${env.imports.length}    call sites ${env.symbols.reduce((n, s) => n + s.callSites.length, 0)}\n`);
        process.stdout.write(`unknowns    ${env.unknowns.length}\n`);
        for (const u of env.unknowns) {
            process.stdout.write(`  - ${u.kind}: ${u.detail}\n`);
        }
        process.stdout.write(`clock       ${env.clock}  cryptoRandom=${env.cryptoRandom}\n`);
        process.stdout.write(`reason      ${env.closure.reason}\n`);
        if (args.allowUnknown && env.closure.confidence === "open") {
            process.stdout.write(`override    --allow-unknown (unsafe; not closed)\n`);
        }
        process.stdout.write(`envelope    ${join(dir, "envelope.json")}\n`);
        process.stdout.write(`hash        ${hashEnvelope(env).slice(0, 16)}…\n`);
        if (refuse)
            process.stdout.write("\n" + formatRefuse(refuse) + "\n");
        if (env.closure.untracedCallSiteIds.length) {
            process.stdout.write("\nno traces; generators are static-shape plus catalog mutations, not your runtime distribution\n");
        }
    }
    if (!env.closure.readyToGenerate)
        return EXIT_REFUSED;
    if (refuse && env.slimmable.verdict === "refuse")
        return EXIT_REFUSED;
    return EXIT_OK;
}
//# sourceMappingURL=inspect.js.map