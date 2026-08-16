import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CliArgs } from "./cli.ts";
import { EXIT_FAIL, EXIT_OK, EXIT_USAGE, SlimExit } from "./exit.ts";
import { loadProject } from "./project.ts";
import { loadConfig } from "./config.ts";
import { analyzePackage } from "./analyze/index.ts";

export async function runCheck(args: CliArgs): Promise<number> {
  const project = loadProject();
  const config = loadConfig(project.root);
  const names = Object.keys(config.replacements);
  if (!names.length) {
    const man = join(project.root, ".slim", "manifest.json");
    if (!existsSync(man)) {
      process.stdout.write("no Slim replacements recorded. Run slim replace <pkg> first.\n");
      return EXIT_OK;
    }
    const json = JSON.parse(readFileSync(man, "utf8")) as {
      replacements?: Record<string, unknown>;
    };
    names.push(...Object.keys(json.replacements ?? {}));
  }
  let failed = false;
  for (const pkg of names) {
    const envPath =
      config.replacements[pkg]?.envelope ?? join(project.root, ".slim", pkg, "envelope.json");
    if (!existsSync(envPath)) {
      process.stderr.write(`missing envelope ${envPath}\n`);
      failed = true;
      continue;
    }
    const saved = JSON.parse(readFileSync(envPath, "utf8")) as {
      symbols: Array<{ exportName: string }>;
    };
    const savedNames = new Set(saved.symbols.map((s) => s.exportName));
    const now = analyzePackage(project, pkg, { allowUnknown: args.allowUnknown });
    const grew = now.symbols.filter((s) => !savedNames.has(s.exportName) && s.exportName !== "*");
    const extraUnknowns = now.unknowns.filter((u) => u.widensTo === "refuse");
    if (args.json) {
      process.stdout.write(
        JSON.stringify({
          pkg,
          grew: grew.map((s) => s.exportName),
          unknowns: extraUnknowns.map((u) => u.kind),
        }) + "\n",
      );
    }
    if (grew.length) {
      process.stderr.write(
        `${pkg}: envelope grew (${grew.map((s) => s.exportName).join(", ")}). re-run slim replace ${pkg}\n`,
      );
      failed = true;
    } else if (!args.json) {
      process.stdout.write(`${pkg}: envelope unchanged (${[...savedNames].join(", ")})\n`);
    }
    if (extraUnknowns.length) {
      process.stderr.write(`${pkg}: new refuse-level unknowns\n`);
      failed = true;
    }
  }
  if (!names.length) return EXIT_OK;
  if (failed) throw new SlimExit(EXIT_FAIL, "slim check failed");
  return EXIT_OK;
}

void EXIT_USAGE;
