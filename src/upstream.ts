import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CliArgs } from "./cli.ts";
import { EXIT_FAIL, EXIT_OK, SlimExit } from "./exit.ts";
import { loadProject } from "./project.ts";
import { loadConfig } from "./config.ts";
import { queryOsv } from "./upstream/osv.ts";
import { npmLatest } from "./upstream/npm.ts";
import { sliceExposure } from "./upstream/slice.ts";
import { createPullRequest } from "./github/pr.ts";

interface Manifest {
  replacements: Record<
    string,
    { version: string; envelopeHash: string; symbols: string[]; module: string }
  >;
}

export async function runUpstream(args: CliArgs): Promise<number> {
  const project = loadProject();
  const config = loadConfig(project.root);
  const manPath = join(project.root, ".slim", "manifest.json");
  if (!existsSync(manPath)) {
    process.stdout.write("no .slim/manifest.json — nothing to watch\n");
    return EXIT_OK;
  }
  const man = JSON.parse(readFileSync(manPath, "utf8")) as Manifest;
  const names = Object.keys(man.replacements);
  let exposed = false;
  const findings: unknown[] = [];
  for (const name of names) {
    const rec = man.replacements[name]!;
    const pinned = rec.version;
    let latest: string = pinned;
    try {
      latest = (await npmLatest(name)).version;
    } catch (err) {
      process.stderr.write(`npm latest failed for ${name}: ${err}\n`);
    }
    const vulnsPinned = await queryOsv(name, pinned).catch(() => []);
    const vulnsLatest = latest !== pinned ? await queryOsv(name, latest).catch(() => []) : [];
    const seen = new Map<string, (typeof vulnsPinned)[0]>();
    for (const v of [...vulnsPinned, ...vulnsLatest]) seen.set(v.id, v);
    for (const v of seen.values()) {
      const exp = sliceExposure(v, rec.symbols);
      findings.push({
        package: name,
        pinned,
        latest,
        id: v.id,
        summary: v.summary,
        exposure: exp,
      });
      if (exp === "exposed" || exp === "unmapped") {
        exposed = true;
        process.stdout.write(
          `${name}: ${v.id} ${exp} — ${v.summary ?? ""}\n  fail-closed: advisory ${exp === "unmapped" ? "could not be mapped to used exports" : "hits this slice"}\n`,
        );
      }
    }
    if (latest !== pinned && seen.size === 0) {
      process.stdout.write(`${name}: ${pinned} → ${latest} (routine release, fail-open)\n`);
    }
  }
  if (args.json) {
    process.stdout.write(JSON.stringify({ findings }, null, 2) + "\n");
  }
  if (exposed && args.pr) {
    mkdirSync(join(project.root, ".slim"), { recursive: true });
    const body = `# Slim upstream review\n\nFail-closed: an advisory may expose this repo's slice.\n\n\`\`\`json\n${JSON.stringify(findings, null, 2)}\n\`\`\`\n`;
    writeFileSync(join(project.root, ".slim", "UPSTREAM.md"), body);
    await createPullRequest({
      root: project.root,
      title: "slim: upstream advisory review",
      body,
      branch: "slim/upstream",
    });
  }
  if (exposed) throw new SlimExit(EXIT_FAIL, "slice exposed or advisory unmapped");
  if (!args.json) process.stdout.write("slice not exposed.\n");
  void config;
  return EXIT_OK;
}
