#!/usr/bin/env node
/**
 * Restore lodash in a temp copy of the golden fixture, run `slim replace`,
 * and copy envelope / evidence / slice / package.json back.
 * traces.jsonl stays gitignored.
 *
 * `--check` refreshes twice into temp dirs and compares equivalent artifacts
 * without writing the repository fixture. Identity fields must also match
 * the committed fixture. Overlay install cannot npm ci after adding lodash;
 * committed package-lock.json sha256 is the lockfile identity.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashEnvelope, type Envelope } from "../src/envelope/types.ts";
import { fixtureRevision, sha256Bytes, sha256File } from "../src/evidence/digests.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO, "fixtures", "lodash-get-debounce");

export const GOLDEN_REFRESH_INPUTS = {
  seed: 1,
  workers: 1,
  budgetMs: 30000,
  templateOnly: true,
  lodashVersion: "4.17.21",
  package: "lodash",
  node: "22.18",
  os: "linux",
} as const;

export interface GoldenRefreshRecord {
  seed: number;
  workers: number;
  budgetMs: number;
  templateOnly: boolean;
  lodashVersion: string;
  package: string;
  node: string;
  os: string;
  lockfileSha256: string;
  envelopeHash: string;
  moduleDigest: string;
  standingDigest: string;
  hardeningDigest: string;
  fixtureRevision: string;
}

const BYTE_FILES = [
  ".slim/lodash/envelope.json",
  "src/slim/lodash.ts",
  "src/slim/lodash.test.ts",
  "src/slim/lodash.hardened.test.ts",
  "src/index.ts",
  "slim.json",
] as const;

const IDENTITY_FILES = [".slim/refresh-inputs.json"] as const;

export function collectGoldenIdentities(
  root: string,
  lockfileRoot = root,
): Pick<
  GoldenRefreshRecord,
  | "lockfileSha256"
  | "envelopeHash"
  | "moduleDigest"
  | "standingDigest"
  | "hardeningDigest"
  | "fixtureRevision"
> {
  const envelope = JSON.parse(readFileSync(join(root, ".slim", "lodash", "envelope.json"), "utf8")) as Envelope;
  const standing = readFileSync(join(root, "src", "slim", "lodash.test.ts"));
  const hardening = readFileSync(join(root, "src", "slim", "lodash.hardened.test.ts"));
  return {
    lockfileSha256: sha256File(join(lockfileRoot, "package-lock.json")),
    envelopeHash: hashEnvelope(envelope),
    moduleDigest: sha256File(join(root, "src", "slim", "lodash.ts")),
    standingDigest: sha256Bytes(standing),
    hardeningDigest: sha256Bytes(hardening),
    fixtureRevision: fixtureRevision(standing, hardening),
  };
}

export function refreshInputsRecord(root: string, lockfileRoot = root): GoldenRefreshRecord {
  return { ...GOLDEN_REFRESH_INPUTS, ...collectGoldenIdentities(root, lockfileRoot) };
}

export function writeRefreshInputs(dest: string, record: GoldenRefreshRecord): void {
  writeFileSync(join(dest, ".slim", "refresh-inputs.json"), JSON.stringify(record, null, 2) + "\n");
}

export function assertGoldenInputs(root: string): string[] {
  const path = join(root, ".slim", "refresh-inputs.json");
  if (!existsSync(path)) return ["refresh-inputs.json"];
  const got = JSON.parse(readFileSync(path, "utf8")) as Partial<GoldenRefreshRecord>;
  const live = refreshInputsRecord(root);
  const mismatches: string[] = [];
  for (const key of Object.keys(GOLDEN_REFRESH_INPUTS) as (keyof typeof GOLDEN_REFRESH_INPUTS)[]) {
    if (got[key] !== GOLDEN_REFRESH_INPUTS[key]) mismatches.push(`refresh-inputs.${key}`);
  }
  if (got.lockfileSha256 !== live.lockfileSha256) mismatches.push("lockfileSha256");
  if (got.envelopeHash !== live.envelopeHash) mismatches.push("envelopeHash");
  if (got.moduleDigest !== live.moduleDigest) mismatches.push("moduleDigest");
  if (got.standingDigest !== live.standingDigest) mismatches.push("standingDigest");
  if (got.hardeningDigest !== live.hardeningDigest) mismatches.push("hardeningDigest");
  if (got.fixtureRevision !== live.fixtureRevision) mismatches.push("fixtureRevision");
  const evidencePath = join(root, ".slim", "lodash", "evidence.json");
  if (!existsSync(evidencePath)) {
    mismatches.push("evidence.json");
    return mismatches;
  }
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
    envelopeHash?: string;
    artifacts?: {
      moduleDigest?: string;
      standingDigest?: string;
      hardeningDigest?: string;
      fixtureRevision?: string;
    };
  };
  if (evidence.envelopeHash !== live.envelopeHash) mismatches.push("evidence.envelopeHash");
  if (evidence.artifacts?.moduleDigest !== live.moduleDigest) mismatches.push("evidence.artifacts.moduleDigest");
  if (evidence.artifacts?.standingDigest !== live.standingDigest) {
    mismatches.push("evidence.artifacts.standingDigest");
  }
  if (evidence.artifacts?.hardeningDigest !== live.hardeningDigest) {
    mismatches.push("evidence.artifacts.hardeningDigest");
  }
  if (evidence.artifacts?.fixtureRevision !== live.fixtureRevision) {
    mismatches.push("evidence.artifacts.fixtureRevision");
  }
  return mismatches;
}

function run(file: string, args: string[], cwd: string): void {
  const r = spawnSync(file, args, { cwd, stdio: "inherit", encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${file} ${args.join(" ")} exited ${r.status}`);
  }
}

function copyIfExists(from: string, to: string): void {
  if (!existsSync(from)) throw new Error(`missing ${from}`);
  cpSync(from, to);
}

function restoreLodashImport(work: string): void {
  const indexPath = join(work, "src", "index.ts");
  const index = readFileSync(indexPath, "utf8").replace(
    /from ["']\.\/slim\/lodash\.ts["']/,
    `from "lodash"`,
  );
  writeFileSync(indexPath, index);

  const pkgPath = join(work, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  pkg.dependencies = { ...(pkg.dependencies ?? {}), lodash: GOLDEN_REFRESH_INPUTS.lodashVersion };
  pkg.devDependencies = {
    ...(pkg.devDependencies ?? {}),
    typescript: pkg.devDependencies?.typescript ?? "^5.9.2",
    "@cloudflare/workers-types":
      pkg.devDependencies?.["@cloudflare/workers-types"] ?? "^4.20250813.0",
  };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

function runReplace(work: string, repo: string): void {
  run(
    process.execPath,
    [
      "--experimental-strip-types",
      join(repo, "src", "main.ts"),
      "replace",
      GOLDEN_REFRESH_INPUTS.package,
      "--no-pr",
      "--no-install",
      "--template-only",
      "--seed",
      String(GOLDEN_REFRESH_INPUTS.seed),
      "--workers",
      String(GOLDEN_REFRESH_INPUTS.workers),
      "--budget-ms",
      String(GOLDEN_REFRESH_INPUTS.budgetMs),
    ],
    work,
  );
}

function assertRefreshSanity(work: string): void {
  const evidence = JSON.parse(readFileSync(join(work, ".slim", "lodash", "evidence.json"), "utf8")) as {
    fuzz: { tracesReplayed: number; seed: number };
    package: { version: string };
  };
  const envelope = JSON.parse(readFileSync(join(work, ".slim", "lodash", "envelope.json"), "utf8")) as {
    env: string[];
    symbols: Array<{ coverage: { callSitesTraced: number } }>;
  };
  if (evidence.fuzz.tracesReplayed < 1) {
    throw new Error(`refresh produced tracesReplayed=${evidence.fuzz.tracesReplayed}`);
  }
  if (evidence.fuzz.seed !== GOLDEN_REFRESH_INPUTS.seed) {
    throw new Error(`refresh seed=${evidence.fuzz.seed} expected ${GOLDEN_REFRESH_INPUTS.seed}`);
  }
  if (evidence.package.version !== GOLDEN_REFRESH_INPUTS.lodashVersion) {
    throw new Error(`refresh lodash version=${evidence.package.version}`);
  }
  if (!envelope.env.includes("worker")) {
    throw new Error(`refresh envelope env=${envelope.env.join(",")} missing worker`);
  }
  if (!envelope.symbols.some((s) => s.coverage.callSitesTraced > 0)) {
    throw new Error("refresh envelope has zero callSitesTraced");
  }
}

function copyArtifacts(from: string, fixture: string): void {
  const slimDir = join(fixture, ".slim", "lodash");
  copyIfExists(join(from, ".slim", "lodash", "envelope.json"), join(slimDir, "envelope.json"));
  copyIfExists(join(from, ".slim", "lodash", "evidence.md"), join(slimDir, "evidence.md"));
  copyIfExists(join(from, ".slim", "lodash", "evidence.json"), join(slimDir, "evidence.json"));
  copyIfExists(join(from, ".slim", "lodash", "traces.meta.json"), join(slimDir, "traces.meta.json"));
  copyIfExists(join(from, "src", "slim", "lodash.ts"), join(fixture, "src", "slim", "lodash.ts"));
  copyIfExists(join(from, "src", "slim", "lodash.test.ts"), join(fixture, "src", "slim", "lodash.test.ts"));
  copyIfExists(
    join(from, "src", "slim", "lodash.hardened.test.ts"),
    join(fixture, "src", "slim", "lodash.hardened.test.ts"),
  );
  copyIfExists(join(from, "src", "index.ts"), join(fixture, "src", "index.ts"));
  copyIfExists(join(from, "package.json"), join(fixture, "package.json"));
  copyIfExists(join(from, "slim.json"), join(fixture, "slim.json"));
  if (existsSync(join(from, ".slim", "manifest.json"))) {
    copyIfExists(join(from, ".slim", "manifest.json"), join(fixture, ".slim", "manifest.json"));
  }
  writeRefreshInputs(fixture, refreshInputsRecord(from, fixture));
}

export function goldenEquivalent(a: string, b: string): string[] {
  const mismatches: string[] = [];
  for (const rel of BYTE_FILES) {
    const leftPath = join(a, rel);
    const rightPath = join(b, rel);
    if (!existsSync(leftPath) || !existsSync(rightPath)) {
      mismatches.push(rel);
      continue;
    }
    const left = readFileSync(leftPath);
    const right = readFileSync(rightPath);
    if (!left.equals(right)) mismatches.push(rel);
  }
  for (const rel of IDENTITY_FILES) {
    const leftPath = join(a, rel);
    const rightPath = join(b, rel);
    if (!existsSync(leftPath) && !existsSync(rightPath)) continue;
    if (!existsSync(leftPath) || !existsSync(rightPath)) {
      mismatches.push(rel);
      continue;
    }
    const left = readFileSync(leftPath);
    const right = readFileSync(rightPath);
    if (!left.equals(right)) mismatches.push(rel);
  }
  const ea = JSON.parse(readFileSync(join(a, ".slim", "lodash", "evidence.json"), "utf8")) as {
    package: { version: string };
    envelopeHash: string;
    byteDelta: { replacement: number };
    generation?: { kind: string };
    artifacts?: {
      moduleDigest?: string;
      standingDigest?: string;
      hardeningDigest?: string;
      fixtureRevision?: string;
    };
    fuzz: { seed: number; tracesReplayed: number; disagreements: number };
  };
  const eb = JSON.parse(readFileSync(join(b, ".slim", "lodash", "evidence.json"), "utf8")) as typeof ea;
  if (ea.fuzz.seed !== eb.fuzz.seed) mismatches.push("evidence.fuzz.seed");
  if (ea.package.version !== eb.package.version) mismatches.push("evidence.package.version");
  if (ea.envelopeHash !== eb.envelopeHash) mismatches.push("evidence.envelopeHash");
  if (ea.byteDelta.replacement !== eb.byteDelta.replacement) mismatches.push("evidence.byteDelta.replacement");
  if ((ea.generation?.kind ?? "") !== (eb.generation?.kind ?? "")) mismatches.push("evidence.generation.kind");
  if (ea.fuzz.tracesReplayed !== eb.fuzz.tracesReplayed) mismatches.push("evidence.fuzz.tracesReplayed");
  if (ea.fuzz.disagreements !== eb.fuzz.disagreements) mismatches.push("evidence.fuzz.disagreements");
  if ((ea.artifacts?.moduleDigest ?? "") !== (eb.artifacts?.moduleDigest ?? "")) {
    mismatches.push("evidence.artifacts.moduleDigest");
  }
  if ((ea.artifacts?.standingDigest ?? "") !== (eb.artifacts?.standingDigest ?? "")) {
    mismatches.push("evidence.artifacts.standingDigest");
  }
  if ((ea.artifacts?.hardeningDigest ?? "") !== (eb.artifacts?.hardeningDigest ?? "")) {
    mismatches.push("evidence.artifacts.hardeningDigest");
  }
  if ((ea.artifacts?.fixtureRevision ?? "") !== (eb.artifacts?.fixtureRevision ?? "")) {
    mismatches.push("evidence.artifacts.fixtureRevision");
  }
  return mismatches;
}

export function refreshGoldenFixture(opts?: {
  repo?: string;
  fixture?: string;
  copyBack?: boolean;
}): string {
  const repo = opts?.repo ?? REPO;
  const fixture = opts?.fixture ?? FIXTURE;
  const work = mkdtempSync(join(tmpdir(), "slim-golden-"));
  cpSync(fixture, work, {
    recursive: true,
    filter: (src) => !src.includes("node_modules") && !src.endsWith("traces.jsonl"),
  });
  restoreLodashImport(work);
  run("npm", ["install", "--no-audit", "--no-fund"], work);
  runReplace(work, repo);
  assertRefreshSanity(work);
  writeRefreshInputs(work, refreshInputsRecord(work, fixture));
  if (opts?.copyBack === false) return work;
  try {
    copyArtifacts(work, fixture);
    const evidence = JSON.parse(readFileSync(join(fixture, ".slim", "lodash", "evidence.json"), "utf8")) as {
      fuzz: { tracesReplayed: number };
    };
    const envelope = JSON.parse(readFileSync(join(fixture, ".slim", "lodash", "envelope.json"), "utf8")) as {
      env: string[];
    };
    process.stdout.write(
      `refreshed golden fixture tracesReplayed=${evidence.fuzz.tracesReplayed} env=${envelope.env.join(",")}\n`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return fixture;
}

export function checkGoldenRefresh(opts?: { repo?: string; fixture?: string }): string[] {
  const fixture = opts?.fixture ?? FIXTURE;
  const a = refreshGoldenFixture({ ...opts, copyBack: false });
  let b = "";
  try {
    b = refreshGoldenFixture({ ...opts, copyBack: false });
    return [
      ...goldenEquivalent(a, b).map((m) => `pair:${m}`),
      ...goldenEquivalent(a, fixture).map((m) => `committed:${m}`),
      ...assertGoldenInputs(fixture).map((m) => `inputs:${m}`),
    ];
  } finally {
    rmSync(a, { recursive: true, force: true });
    if (b) rmSync(b, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (process.argv.includes("--check")) {
    const mismatches = checkGoldenRefresh();
    if (mismatches.length) {
      process.stderr.write(`golden refresh mismatch: ${mismatches.join(", ")}\n`);
      process.exit(1);
    }
    process.stdout.write("golden refresh check: equivalent\n");
  } else {
    refreshGoldenFixture({ copyBack: true });
  }
}
