/**
 * MIT License
 *
 * Cross-check PR title, body, branch, files, and labels against the accepted
 * replacement (or upstream) transaction before any git mutation.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hashEnvelope, type Envelope } from "../envelope/types.ts";
import type { EvidenceJson } from "../evidence/report.ts";
import { EXIT_FAIL, SlimExit } from "../exit.ts";
import { fileBase } from "../rewrite/paths.ts";

export const REPLACE_PR_LABELS = ["slim", "slim:replace"] as const;
export const UPSTREAM_PR_LABELS = ["slim", "slim:upstream"] as const;

export type PrKind = "replace" | "upstream";

export interface PrRequest {
  root: string;
  title: string;
  body: string;
  branch: string;
  files: string[];
  labels: string[];
  kind?: PrKind;
  pkg?: string;
}

export function sha256Bytes(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

function field(body: string, re: RegExp, name: string): string {
  const m = body.match(re);
  if (!m?.[1]) {
    throw new SlimExit(EXIT_FAIL, `PR body missing ${name}`);
  }
  return m[1];
}

function labelsEqual(got: string[], want: readonly string[]): boolean {
  if (got.length !== want.length) return false;
  return got.every((l, i) => l === want[i]);
}

function inferPkg(opts: PrRequest): string {
  if (opts.pkg) return opts.pkg;
  for (const f of opts.files) {
    const m = f.replace(/\\/g, "/").match(/^\.slim\/(.+)\/evidence\.md$/);
    if (m?.[1]) return m[1];
  }
  const titled = opts.title.match(/^slim: replace (.+) with a verified slice$/);
  if (titled?.[1]) return titled[1];
  throw new SlimExit(EXIT_FAIL, "cannot infer package for pull request transaction");
}

function inferKind(opts: PrRequest): PrKind {
  if (opts.kind) return opts.kind;
  if (opts.branch === "slim/upstream" || opts.labels.includes("slim:upstream")) return "upstream";
  return "replace";
}

function isAllowedReplacePath(rel: string, pkg: string, moduleRel: string, rewrites: string[]): boolean {
  const p = rel.replace(/\\/g, "/");
  if (p.startsWith(".slim/")) return true;
  if (p === moduleRel || p.startsWith("src/slim/")) return true;
  if (p === "package.json" || p === "slim.json") return true;
  if (/^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(p)) return true;
  if (rewrites.includes(p)) return true;
  if (p === `src/slim/${fileBase(pkg)}.ts` || p === `src/slim/${fileBase(pkg)}.js`) return true;
  return false;
}

function loadJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new SlimExit(EXIT_FAIL, `missing or malformed ${what}`);
  }
}

export function assertEvidenceBodyMatchesDisk(root: string, pkg: string, body: string): string {
  const evidenceJsonPath = join(root, ".slim", pkg, "evidence.json");
  const envelopePath = join(root, ".slim", pkg, "envelope.json");
  const evidence = loadJson(evidenceJsonPath, `.slim/${pkg}/evidence.json`) as EvidenceJson;
  const envelope = loadJson(envelopePath, `.slim/${pkg}/envelope.json`) as Envelope;
  const envHash = hashEnvelope(envelope);
  if (evidence.envelopeHash !== envHash) {
    throw new SlimExit(EXIT_FAIL, "evidence.json envelope hash does not match envelope.json");
  }
  const moduleRel = (evidence.revert?.module ?? `src/slim/${fileBase(pkg)}.ts`).replace(/\\/g, "/");
  const modulePath = join(root, moduleRel);
  if (!existsSync(modulePath)) {
    throw new SlimExit(EXIT_FAIL, `missing replacement module ${moduleRel}`);
  }
  const evidenceHash = sha256File(evidenceJsonPath);
  const moduleDigest = sha256File(modulePath);

  const bodyPkg = field(body, /Package:\s+`([^`]+)`/, "package");
  const wantPkg = `${evidence.package.name}@${evidence.package.version}`;
  if (bodyPkg !== wantPkg) {
    throw new SlimExit(EXIT_FAIL, `PR package ${bodyPkg} does not match ${wantPkg}`);
  }
  const bodyEnv = field(body, /Envelope hash:\s+`([0-9a-f]+)`/i, "envelope hash");
  if (bodyEnv !== evidence.envelopeHash || bodyEnv !== envHash) {
    throw new SlimExit(EXIT_FAIL, "PR envelope hash does not match accepted evidence");
  }
  const bodyEvidence = field(body, /Evidence hash:\s+`([0-9a-f]+)`/i, "evidence hash");
  if (bodyEvidence !== evidenceHash) {
    throw new SlimExit(EXIT_FAIL, "PR evidence hash does not match evidence.json");
  }
  const bodyModule = field(body, /Module digest:\s+`([0-9a-f]+)`/i, "module digest");
  if (bodyModule !== moduleDigest) {
    throw new SlimExit(EXIT_FAIL, "PR module digest does not match the replacement file");
  }
  const bodySeed = field(body, /seed:\s+(\d+)/i, "fuzz seed");
  if (Number(bodySeed) !== evidence.fuzz.seed) {
    throw new SlimExit(EXIT_FAIL, "PR fuzz seed does not match evidence.json");
  }
  const bodyCases = field(body, /cases:\s+(\d+)/i, "fuzz cases");
  if (Number(bodyCases) !== evidence.fuzz.cases) {
    throw new SlimExit(EXIT_FAIL, "PR fuzz cases do not match evidence.json");
  }
  const bodyDisagree = field(body, /disagreements:\s+(\d+)/i, "fuzz disagreements");
  if (Number(bodyDisagree) !== evidence.fuzz.disagreements) {
    throw new SlimExit(EXIT_FAIL, "PR fuzz disagreements do not match evidence.json");
  }
  return moduleRel;
}

function assertReplaceTransaction(opts: PrRequest): void {
  const pkg = inferPkg(opts);
  const wantLabels = [...REPLACE_PR_LABELS];
  if (!labelsEqual(opts.labels, wantLabels)) {
    throw new SlimExit(
      EXIT_FAIL,
      `PR labels must be ${wantLabels.join(", ")}; got ${opts.labels.join(", ") || "(none)"}`,
    );
  }
  const wantBranch = `slim/${fileBase(pkg)}`;
  if (opts.branch !== wantBranch) {
    throw new SlimExit(EXIT_FAIL, `PR branch ${opts.branch} does not match ${wantBranch}`);
  }
  if (opts.title !== `slim: replace ${pkg} with a verified slice`) {
    throw new SlimExit(EXIT_FAIL, `PR title does not name package ${pkg}`);
  }

  const moduleRel = assertEvidenceBodyMatchesDisk(opts.root, pkg, opts.body);
  const evidenceJsonPath = join(opts.root, ".slim", pkg, "evidence.json");
  const evidence = loadJson(evidenceJsonPath, `.slim/${pkg}/evidence.json`) as EvidenceJson;

  const files = opts.files.map((f) => f.replace(/\\/g, "/"));
  const required = [
    moduleRel,
    `.slim/${pkg}/evidence.md`,
    `.slim/${pkg}/evidence.json`,
    `.slim/${pkg}/envelope.json`,
  ];
  for (const req of required) {
    if (!files.includes(req)) {
      throw new SlimExit(EXIT_FAIL, `PR file list missing ${req}`);
    }
  }
  const rewrites = (evidence.revert?.rewrites ?? []).map((r) => r.file.replace(/\\/g, "/"));
  for (const f of files) {
    if (!isAllowedReplacePath(f, pkg, moduleRel, rewrites)) {
      throw new SlimExit(EXIT_FAIL, `refusing to commit unrelated path ${f}`);
    }
  }
}

function assertUpstreamTransaction(opts: PrRequest): void {
  const wantLabels = [...UPSTREAM_PR_LABELS];
  if (!labelsEqual(opts.labels, wantLabels)) {
    throw new SlimExit(
      EXIT_FAIL,
      `PR labels must be ${wantLabels.join(", ")}; got ${opts.labels.join(", ") || "(none)"}`,
    );
  }
  if (opts.branch !== "slim/upstream") {
    throw new SlimExit(EXIT_FAIL, `PR branch ${opts.branch} does not match slim/upstream`);
  }
  if (!/^slim: upstream slice fix for \S+$/.test(opts.title)) {
    throw new SlimExit(EXIT_FAIL, "PR title does not match slim: upstream slice fix for <id>");
  }
  const files = opts.files.map((f) => f.replace(/\\/g, "/"));
  if (!files.includes(".slim/UPSTREAM.md")) {
    throw new SlimExit(EXIT_FAIL, "PR file list missing .slim/UPSTREAM.md");
  }
  if (!/EVIDENCE, NOT PROOF/i.test(opts.body)) {
    throw new SlimExit(EXIT_FAIL, "upstream PR body missing EVIDENCE, NOT PROOF");
  }
  const regenerated = /regenerated the replacement and fuzzed/i.test(opts.body);
  const unmapped = /could not be mapped/i.test(opts.body);
  if (unmapped && regenerated) {
    throw new SlimExit(EXIT_FAIL, "unmapped upstream PR cannot claim a successful rewrite");
  }
  if (!unmapped && !regenerated && !/no automatic fix|verification unavailable|may expose this repo/i.test(opts.body)) {
    throw new SlimExit(EXIT_FAIL, "upstream PR body is missing a fail-closed conclusion");
  }
  if (/Evidence hash:/i.test(opts.body)) {
    const pkgs = new Set<string>();
    for (const f of files) {
      const m = f.match(/^\.slim\/(.+)\/evidence\.md$/);
      if (m?.[1]) pkgs.add(m[1]);
    }
    if (!pkgs.size) {
      const m = opts.body.match(/Package:\s+`([^@`]+)/);
      if (m?.[1]) pkgs.add(m[1]);
    }
    for (const pkg of pkgs) {
      assertEvidenceBodyMatchesDisk(opts.root, pkg, opts.body);
    }
  }
}

export function assertPrMatchesTransaction(opts: PrRequest): void {
  if (!opts.labels?.length) {
    throw new SlimExit(EXIT_FAIL, "PR labels must match the accepted transaction");
  }
  const kind = inferKind(opts);
  if (kind === "upstream") assertUpstreamTransaction(opts);
  else assertReplaceTransaction(opts);
}

export function assertCommitMatchesTransaction(
  gitOut: (args: readonly string[]) => string,
  sha: string,
  files: string[],
  title: string,
  head: string,
): void {
  const parent = gitOut(["rev-parse", `${sha}^`]).trim();
  if (parent !== head) {
    throw new SlimExit(EXIT_FAIL, `Slim commit parent ${parent} is not HEAD ${head}`);
  }
  const message = gitOut(["log", "-1", "--format=%s", sha]).trim();
  if (message !== title) {
    throw new SlimExit(EXIT_FAIL, `Slim commit message does not match PR title`);
  }
  const names = gitOut(["diff-tree", "--no-commit-id", "--name-only", "-r", sha])
    .split("\n")
    .map((s) => s.trim().replace(/\\/g, "/"))
    .filter(Boolean)
    .sort();
  const expected = [...files].map((f) => f.replace(/\\/g, "/")).sort();
  if (names.length !== expected.length || names.some((n, i) => n !== expected[i])) {
    throw new SlimExit(
      EXIT_FAIL,
      `Slim commit files [${names.join(", ")}] do not match [${expected.join(", ")}]`,
    );
  }
}
