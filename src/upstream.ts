import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { CliArgs } from "./cli.ts";
import { EXIT_ENV, EXIT_FAIL, EXIT_OK, SlimExit } from "./exit.ts";
import { JSON_SCHEMA_VERSION, statusFromExit, writeJson } from "./json.ts";
import { loadProject } from "./project.ts";
import { loadConfig } from "./config.ts";
import { queryOsv, type OsvVuln } from "./upstream/osv.ts";
import { npmLatest } from "./upstream/npm.ts";
import { sliceExposure } from "./upstream/slice.ts";
import { createPullRequest, probeGithubAvailability } from "./github/pr.ts";
import {
  applyUpstreamFix,
  canFuzzOracle,
  type UpstreamDeps,
  type UpstreamFinding,
  type ApplyUpstreamFixResult,
} from "./upstream/fix.ts";
import { assertReplacementState, type ReplacementRecord } from "./upstream/state.ts";
import {
  cmpVersion,
  isConsultedFailure,
  sourceNotRequired,
  sourceErr,
  type SourceResult,
  type SourceStatus,
} from "./upstream/status.ts";

export type { UpstreamDeps, UpstreamFinding, UpstreamOracle } from "./upstream/fix.ts";
export { applyUpstreamFix } from "./upstream/fix.ts";

export type UpstreamConclusion =
  | "exposed"
  | "not-exposed"
  | "unmapped"
  | "routine-release"
  | "source-unavailable"
  | "oracle-unavailable";

export interface SourceReport {
  status: SourceStatus;
  detail: string;
}

interface Manifest {
  replacements: Record<string, ReplacementRecord>;
}

interface UpstreamReport {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  ok: boolean;
  exit: number;
  status: ReturnType<typeof statusFromExit>;
  conclusion: UpstreamConclusion;
  sources: { osv: SourceReport; npm: SourceReport; oracle: SourceReport; github: SourceReport };
  findings: UpstreamFinding[];
  error?: string;
}

export async function runUpstream(args: CliArgs, deps: UpstreamDeps = {}): Promise<number> {
  const project = loadProject(deps.cwd);
  const config = loadConfig(project.root);
  const query = deps.queryOsv ?? queryOsv;
  const latestOf = deps.npmLatest ?? npmLatest;
  const openPr = deps.createPullRequest ?? createPullRequest;
  const manPath = join(project.root, ".slim", "manifest.json");

  const notRequired = (): SourceReport => sourceNotRequired();
  let sources = {
    osv: notRequired(),
    npm: notRequired(),
    oracle: notRequired(),
    github: notRequired(),
  };

  if (!existsSync(manPath)) {
    return finish(
      args,
      {
        schemaVersion: JSON_SCHEMA_VERSION,
        ok: true,
        exit: EXIT_OK,
        status: "ok",
        conclusion: "not-exposed",
        sources,
        findings: [],
      },
      "no .slim/manifest.json — nothing to watch\n",
    );
  }
  let man: Manifest;
  try {
    man = JSON.parse(readFileSync(manPath, "utf8")) as Manifest;
  } catch {
    throw new SlimExit(EXIT_FAIL, "malformed .slim/manifest.json");
  }

  const names = Object.keys(man.replacements ?? {});
  for (const name of names) {
    assertReplacementState(project.root, name, man.replacements[name]!, config.outDir);
  }

  if (args.pr) {
    sources.github = deps.githubStatus ? deps.githubStatus() : probeGithubAvailability(project.root);
  }

  if (isConsultedFailure(sources.github)) {
    return finish(
      args,
      reportOf("source-unavailable", EXIT_ENV, sources, [], `github ${sources.github.detail}`),
      null,
      `github ${sources.github.detail}`,
    );
  }

  const findings: UpstreamFinding[] = [];
  const routineLines: string[] = [];
  const osvStatuses: SourceReport[] = [];
  const npmStatuses: SourceReport[] = [];

  for (const name of names) {
    const rec = man.replacements[name]!;
    const pinned = rec.version;
    let npmRes = await latestOf(name);
    if (npmRes.status === "success" && npmRes.value) {
      const latest = npmRes.value.version;
      if (cmpVersion(latest, pinned) < 0) {
        npmRes = sourceErr("stale", `npm latest ${latest} is older than pinned ${pinned}`);
      } else if (npmRes.value.versions && !npmRes.value.versions.includes(pinned)) {
        npmRes = sourceErr("stale", `pinned ${pinned} absent from npm registry`);
      }
    }
    npmStatuses.push({ status: npmRes.status, detail: npmRes.detail });

    const latest = npmRes.status === "success" && npmRes.value ? npmRes.value.version : pinned;

    const pinnedOsv = await query(name, pinned);
    osvStatuses.push({ status: pinnedOsv.status, detail: pinnedOsv.detail });
    let latestOsv: SourceResult<OsvVuln[]> = { status: "success", detail: "not required", value: [] };
    if (npmRes.status === "success" && latest !== pinned) {
      latestOsv = await query(name, latest);
      osvStatuses.push({ status: latestOsv.status, detail: latestOsv.detail });
    }

    if (isConsultedFailure(npmRes) || isConsultedFailure(pinnedOsv) || isConsultedFailure(latestOsv)) {
      continue;
    }

    const seen = new Map<string, OsvVuln>();
    for (const v of [...(pinnedOsv.value ?? []), ...(latestOsv.value ?? [])]) seen.set(v.id, v);
    for (const v of seen.values()) {
      const exp = sliceExposure(v, rec.symbols);
      findings.push({
        package: name,
        pinned,
        latest,
        id: v.id,
        summary: v.summary,
        details: v.details,
        exposure: exp.exposure,
        affectedRange: exp.affectedRange,
        usedSymbols: rec.symbols,
        mappedEvidence: exp.mappedEvidence,
        upstreamChange: latest === pinned ? `pinned ${pinned}` : `${pinned} → ${latest}`,
        unmappedReason: exp.unmappedReason,
      });
    }
    if (latest !== pinned && seen.size === 0) {
      routineLines.push(`${name}: ${pinned} → ${latest} (routine release, fail-open)\n`);
    }
  }

  sources.npm = worstSource(npmStatuses, sources.npm);
  sources.osv = worstSource(osvStatuses, sources.osv);

  if (
    isConsultedFailure(sources.npm) ||
    isConsultedFailure(sources.osv) ||
    isConsultedFailure(sources.github)
  ) {
    return finish(
      args,
      reportOf("source-unavailable", EXIT_ENV, sources, findings, sourceFailDetail(sources)),
      null,
      sourceFailDetail(sources),
    );
  }

  const hasUnmapped = findings.some((f) => f.exposure === "unmapped");
  const hasExposed = findings.some((f) => f.exposure === "exposed");
  const fixResults: ApplyUpstreamFixResult[] = [];

  if (hasExposed) {
    const exposedJobs: { name: string; rec: ReplacementRecord; pkgFindings: UpstreamFinding[] }[] = [];
    for (const name of names) {
      const rec = man.replacements[name]!;
      const pkgFindings = findings.filter((f) => f.package === name && f.exposure === "exposed");
      if (!pkgFindings.length) continue;
      exposedJobs.push({ name, rec, pkgFindings });
    }
    let oracleOk = true;
    for (const job of exposedJobs) {
      const ok = await canFuzzOracle(
        { root: project.root, pkg: job.name, rec: job.rec, findings: job.pkgFindings, args, config },
        deps,
      );
      if (!ok) {
        oracleOk = false;
        break;
      }
    }
    if (!oracleOk) {
      sources.oracle = { status: "unavailable", detail: "fuzz skipped: no installable oracle" };
    } else {
      for (const job of exposedJobs) {
        fixResults.push(
          await applyUpstreamFix(
            { root: project.root, pkg: job.name, rec: job.rec, findings: job.pkgFindings, args, config },
            deps,
          ),
        );
      }
      if (fixResults.some((r) => r.fuzzed)) {
        sources.oracle = { status: "success", detail: "ok" };
      }
    }
  }

  let conclusion: UpstreamConclusion;
  let exit: number;
  let msg: string;
  if (hasUnmapped) {
    conclusion = "unmapped";
    exit = EXIT_FAIL;
    msg = "slice exposed or advisory unmapped";
  } else if (hasExposed && isConsultedFailure(sources.oracle)) {
    conclusion = "oracle-unavailable";
    exit = EXIT_FAIL;
    msg = "verification unavailable: no installable oracle";
  } else if (hasExposed) {
    conclusion = "exposed";
    exit = EXIT_FAIL;
    msg = "slice exposed or advisory unmapped";
  } else if (routineLines.length) {
    conclusion = "routine-release";
    exit = EXIT_OK;
    msg = "";
  } else {
    conclusion = "not-exposed";
    exit = EXIT_OK;
    msg = "";
  }

  emitHuman(args, findings, routineLines, conclusion, sources);

  const review = conclusion === "unmapped" || conclusion === "exposed";
  if (review) {
    mkdirSync(join(project.root, ".slim"), { recursive: true });
    writeFileSync(join(project.root, ".slim", "UPSTREAM.md"), prBody(project.root, findings, fixResults));
  }

  if (review && args.pr) {
    const firstId =
      findings.find((f) => f.exposure === "exposed" || f.exposure === "unmapped")?.id ?? "advisory";
    const body = readFileSync(join(project.root, ".slim", "UPSTREAM.md"), "utf8");
    await openPr({
      root: project.root,
      title: `slim: upstream slice fix for ${firstId}`,
      body,
      branch: "slim/upstream",
      files: upstreamPrFiles(project.root, man, fixResults),
    });
  }

  return finish(
    args,
    reportOf(conclusion, exit, sources, findings, exit === EXIT_OK ? undefined : msg),
    conclusion === "not-exposed" ? "slice not exposed.\n" : conclusion === "routine-release" ? null : null,
    exit === EXIT_OK ? undefined : msg,
  );
}

function emitHuman(
  args: CliArgs,
  findings: UpstreamFinding[],
  routineLines: string[],
  conclusion: UpstreamConclusion,
  sources: UpstreamReport["sources"],
): void {
  const write = args.json
    ? (s: string) => process.stderr.write(s)
    : (s: string) => process.stdout.write(s);
  for (const f of findings) {
    if (f.exposure === "exposed" || f.exposure === "unmapped") {
      write(
        `${f.package}: ${f.id} ${f.exposure} — ${f.summary ?? ""}\n  fail-closed: advisory ${f.exposure === "unmapped" ? "could not be mapped to used exports" : "hits this slice"}\n`,
      );
    }
  }
  if (conclusion !== "source-unavailable") {
    for (const line of routineLines) write(line);
  }
  if (conclusion === "oracle-unavailable") {
    write(`verification unavailable: ${sources.oracle.detail}\n`);
  }
}

function finish(
  args: CliArgs,
  doc: UpstreamReport,
  humanOk: string | null,
  failMsg?: string,
): number {
  if (args.json) writeJson(doc);
  if (doc.exit !== EXIT_OK) {
    throw new SlimExit(doc.exit, failMsg || doc.error || "upstream failed", { skipJson: args.json });
  }
  if (humanOk && !args.json) process.stdout.write(humanOk);
  return doc.exit;
}

function reportOf(
  conclusion: UpstreamConclusion,
  exit: number,
  sources: UpstreamReport["sources"],
  findings: UpstreamFinding[],
  error?: string,
): UpstreamReport {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    ok: exit === EXIT_OK,
    exit,
    status: statusFromExit(exit),
    conclusion,
    sources,
    findings,
    ...(error ? { error } : {}),
  };
}

function worstSource(rows: SourceReport[], fallback: SourceReport): SourceReport {
  const consulted = rows.filter((s) => s.detail !== "not required");
  if (!consulted.length) return fallback;
  const fail = consulted.find(isConsultedFailure);
  return fail ?? consulted[consulted.length - 1]!;
}

function sourceFailDetail(sources: UpstreamReport["sources"]): string {
  const hits = (["osv", "npm", "github"] as const)
    .filter((k) => isConsultedFailure(sources[k]))
    .map((k) => `${k}: ${sources[k].detail}`);
  return hits.join("; ") || "source unavailable";
}

function upstreamPrFiles(
  root: string,
  man: Manifest,
  results: ApplyUpstreamFixResult[],
): string[] {
  const files = new Set<string>([".slim/UPSTREAM.md", ".slim/manifest.json"]);
  if (existsSync(join(root, "slim.json"))) files.add("slim.json");
  for (const [name, rec] of Object.entries(man.replacements)) {
    files.add(join(".slim", name, "evidence.md"));
    files.add(join(".slim", name, "evidence.json"));
    files.add(join(".slim", name, "envelope.json"));
    files.add(rec.module);
    files.add(rec.module.replace(/\.(ts|js|mjs|cjs)$/, ".hardened.test.ts"));
  }
  for (const r of results) {
    if (r.hardenedTest) files.add(relative(root, r.hardenedTest).replace(/\\/g, "/"));
  }
  return [...files]
    .map((f) => f.replace(/\\/g, "/"))
    .filter((f) => existsSync(join(root, f)));
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
  const regenerated = results.filter((r) => r.regenerated && r.fuzzed);
  const unmappedOnly = findings.some((f) => f.exposure === "unmapped") && !regenerated.length;
  const intro = unmappedOnly
    ? "Fail-closed: an advisory could not be mapped to used exports. Human must decide. Slim did not write an automatic fix."
    : regenerated.length && regenerated.length === results.filter((r) => r.pkg).length && results.every((r) => r.fuzzed)
      ? "Fail-closed: an advisory may expose this repo's slice. Slim regenerated the replacement and fuzzed it."
      : results.some((r) => r.fuzzSkipReason)
        ? "Fail-closed: an advisory may expose this repo's slice. verification unavailable: no installable oracle."
        : "Fail-closed: an advisory may expose this repo's slice.";
  const fuzzLines = results
    .map((r) =>
      r.fuzzed && r.fuzz
        ? `- ${r.pkg}: cases: ${r.fuzz.cases} comparisons: ${r.fuzz.comparisons} timerCases: ${r.fuzz.timerCases}`
        : `- ${r.pkg}: ${r.fuzzSkipReason ?? "no automatic fix"}`,
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
