import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CliArgs } from "./cli.ts";
import { EXIT_FAIL, EXIT_OK, SlimExit } from "./exit.ts";
import { loadProject } from "./project.ts";
import { loadConfig } from "./config.ts";
import { queryOsv, type OsvVuln } from "./upstream/osv.ts";
import { npmLatest } from "./upstream/npm.ts";
import { sliceExposure } from "./upstream/slice.ts";
import { createPullRequest } from "./github/pr.ts";
import { applyUpstreamFix, type UpstreamDeps, type UpstreamFinding, type ApplyUpstreamFixResult } from "./upstream/fix.ts";

export type { UpstreamDeps, UpstreamFinding, UpstreamOracle } from "./upstream/fix.ts";
export { applyUpstreamFix } from "./upstream/fix.ts";

interface Manifest {
  replacements: Record<
    string,
    { version: string; envelopeHash: string; symbols: string[]; module: string }
  >;
}

export async function runUpstream(args: CliArgs, deps: UpstreamDeps = {}): Promise<number> {
  const project = loadProject(deps.cwd);
  const config = loadConfig(project.root);
  const query = deps.queryOsv ?? queryOsv;
  const latestOf = deps.npmLatest ?? npmLatest;
  const openPr = deps.createPullRequest ?? createPullRequest;
  const manPath = join(project.root, ".slim", "manifest.json");
  if (!existsSync(manPath)) {
    process.stdout.write("no .slim/manifest.json — nothing to watch\n");
    return EXIT_OK;
  }
  const man = JSON.parse(readFileSync(manPath, "utf8")) as Manifest;
  const names = Object.keys(man.replacements);
  let exposed = false;
  const findings: UpstreamFinding[] = [];
  for (const name of names) {
    const rec = man.replacements[name]!;
    const pinned = rec.version;
    let latest: string = pinned;
    try {
      latest = (await latestOf(name)).version;
    } catch (err) {
      process.stderr.write(`npm latest failed for ${name}: ${err}\n`);
    }
    const vulnsPinned = await query(name, pinned).catch(() => []);
    const vulnsLatest = latest !== pinned ? await query(name, latest).catch(() => []) : [];
    const seen = new Map<string, OsvVuln>();
    for (const v of [...vulnsPinned, ...vulnsLatest]) seen.set(v.id, v);
    for (const v of seen.values()) {
      const exp = sliceExposure(v, rec.symbols);
      findings.push({
        package: name,
        pinned,
        latest,
        id: v.id,
        summary: v.summary,
        details: v.details,
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
  const fixResults: ApplyUpstreamFixResult[] = [];
  if (exposed) {
    for (const name of names) {
      const rec = man.replacements[name]!;
      const pkgFindings = findings.filter(
        (f) => f.package === name && (f.exposure === "exposed" || f.exposure === "unmapped"),
      );
      if (!pkgFindings.length) continue;
      fixResults.push(
        await applyUpstreamFix(
          { root: project.root, pkg: name, rec, findings: pkgFindings, args, config },
          deps,
        ),
      );
    }
  }
  if (exposed && args.pr) {
    mkdirSync(join(project.root, ".slim"), { recursive: true });
    const firstId =
      findings.find((f) => f.exposure === "exposed" || f.exposure === "unmapped")?.id ?? "advisory";
    const body = prBody(project.root, findings, fixResults);
    writeFileSync(join(project.root, ".slim", "UPSTREAM.md"), body);
    await openPr({
      root: project.root,
      title: `slim: upstream slice fix for ${firstId}`,
      body,
      branch: "slim/upstream",
    });
  }
  if (exposed) throw new SlimExit(EXIT_FAIL, "slice exposed or advisory unmapped");
  if (!args.json) process.stdout.write("slice not exposed.\n");
  return EXIT_OK;
}

function prBody(root: string, findings: UpstreamFinding[], results: ApplyUpstreamFixResult[]): string {
  const pkgs = [
    ...new Set(
      findings
        .filter((f) => f.exposure === "exposed" || f.exposure === "unmapped")
        .map((f) => f.package),
    ),
  ];
  let evidence = "";
  for (const pkg of pkgs) {
    const p = join(root, ".slim", pkg, "evidence.md");
    if (existsSync(p)) evidence += readFileSync(p, "utf8") + "\n";
  }
  if (!evidence.includes("EVIDENCE, NOT PROOF")) {
    evidence =
      (evidence ? evidence + "\n" : "") +
      "EVIDENCE, NOT PROOF — differential fuzzing is evidence, not proof.\n";
  }
  const fuzzedAll = results.length > 0 && results.every((r) => r.fuzzed);
  const skipped = results.filter((r) => !r.fuzzed);
  const intro = fuzzedAll
    ? "Fail-closed: an advisory may expose this repo's slice. Slim regenerated the replacement and fuzzed it."
    : skipped.length
      ? "Fail-closed: an advisory may expose this repo's slice. Slim regenerated the replacement. fuzz skipped: no installable oracle."
      : "Fail-closed: an advisory may expose this repo's slice. Slim regenerated the replacement.";
  const fuzzLines = results
    .map((r) =>
      r.fuzzed && r.fuzz
        ? `- ${r.pkg}: cases: ${r.fuzz.cases} comparisons: ${r.fuzz.comparisons} timerCases: ${r.fuzz.timerCases}`
        : `- ${r.pkg}: ${r.fuzzSkipReason ?? "fuzz skipped: no installable oracle"}`,
    )
    .join("\n");
  return `# Slim upstream slice fix

${intro}

EVIDENCE, NOT PROOF — differential fuzzing is evidence, not proof.

## Fuzz

${fuzzLines || "- (no fix attempt)"}

## Findings

\`\`\`json
${JSON.stringify(findings, null, 2)}
\`\`\`

## Evidence

${evidence}
`;
}
