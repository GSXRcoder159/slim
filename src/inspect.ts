import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliArgs } from "./cli.ts";
import { EXIT_OK, EXIT_USAGE, SlimExit } from "./exit.ts";
import { loadProject } from "./project.ts";
import { analyzePackage } from "./analyze/index.ts";
import { hashEnvelope } from "./envelope/hash.ts";
import { refusePackage, formatRefuse } from "./scan/refuse.ts";
import { EXIT_REFUSED } from "./exit.ts";

export async function runInspect(args: CliArgs): Promise<number> {
  if (!args.pkg) {
    throw new SlimExit(EXIT_USAGE, "usage: slim inspect <pkg>");
  }
  const project = loadProject();
  const refuse = refusePackage(args.pkg);
  const env = analyzePackage(project, args.pkg, { allowUnknown: args.allowUnknown });
  const dir = join(project.root, ".slim", env.package.family || args.pkg);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "envelope.json"), JSON.stringify(env, null, 2) + "\n");

  if (args.json) {
    process.stdout.write(JSON.stringify({ envelope: env, hash: hashEnvelope(env) }, null, 2) + "\n");
  } else {
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
    process.stdout.write(`envelope    ${join(dir, "envelope.json")}\n`);
    process.stdout.write(`hash        ${hashEnvelope(env).slice(0, 16)}…\n`);
    if (refuse) process.stdout.write("\n" + formatRefuse(refuse) + "\n");
    if (env.closure.untracedCallSiteIds.length) {
      process.stdout.write(
        "\nno traces; generators are static-shape plus catalog mutations, not your runtime distribution\n",
      );
    }
  }
  if (refuse && env.slimmable.verdict === "refuse") return EXIT_REFUSED;
  return EXIT_OK;
}
