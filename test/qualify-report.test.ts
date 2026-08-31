import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_FAIL, EXIT_USAGE, SlimExit } from "../src/exit.ts";
import { writeQualifyBundle, assertQualifyBundle } from "../src/release/bundle.ts";
import { assertDocument, validateNamed } from "../src/schema/documents.ts";
import { qualifyReport, writeQualifyReport, QUALIFY_REPORT_NAME } from "../src/support/qualify-report.ts";
import { packSlim, rmPackedTemp } from "./helpers/llm-replace.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT = "a".repeat(40);
const NPM = "b".repeat(64);
const ACTION = "c".repeat(64);
const RUN = "33287137687";

function sampleReport(extra: {
  commit?: string;
  npmDigest?: string;
  actionDigest?: string;
  workflowRun?: string;
  entryCount?: number;
  failures?: { entryId: string; reason: string }[];
} = {}) {
  return qualifyReport({
    commit: COMMIT,
    npmDigest: NPM,
    actionDigest: ACTION,
    workflowRun: RUN,
    qualificationRun: RUN,
    entryCount: 139,
    failures: [],
    ...extra,
  });
}

function tarStub(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const tarball = join(dir, "pkg.tgz");
  writeFileSync(tarball, "not-a-real-tarball");
  return tarball;
}

test("qualifyReport pass document is schema-valid", () => {
  const doc = sampleReport();
  assertDocument("qualifyReport", doc);
  assert.equal(doc.outcome, "pass");
  assert.equal(doc.schemaVersion, 1);
  assert.match(doc.summary, /passed 139/);
  assert.equal(validateNamed("qualifyReport", { ...doc, extra: true })?.kind, "malformed");
});

test("qualifyReport fail document lists failures", () => {
  const doc = qualifyReport({
    commit: COMMIT,
    npmDigest: NPM,
    actionDigest: ACTION,
    workflowRun: RUN,
    qualificationRun: RUN,
    entryCount: 2,
    failures: [{ entryId: "provider.openai", reason: "missing workflow run" }],
  });
  assert.equal(doc.outcome, "fail");
  assert.equal(doc.failures.length, 1);
  assert.match(doc.summary, /failed 1 of 2/);
});

test("qualify-handoff prints one JSON document and writes the gitignored path", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-handoff-"));
  const receipts = join(root, "receipts");
  mkdirSync(receipts, { recursive: true });
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      join(ROOT, "scripts/qualify-handoff.ts"),
      "--commit",
      COMMIT,
      "--npm-digest",
      NPM,
      "--action-digest",
      ACTION,
      "--workflow-run",
      RUN,
      "--qualification-run",
      RUN,
      "--receipts",
      receipts,
      "--root",
      ROOT,
    ],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, SLIM_WORKFLOW_RUN: "", GITHUB_RUN_ID: "" } },
  );
  assert.equal(r.status, EXIT_FAIL);
  const lines = r.stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, r.stdout);
  const doc = JSON.parse(lines[0]!) as { outcome: string; schemaVersion: number };
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.outcome, "fail");
  assertDocument("qualifyReport", doc);
  const written = join(root, QUALIFY_REPORT_NAME);
  assert.equal(existsSync(written), true);
  rmSync(root, { recursive: true, force: true });
});

test("qualify-handoff refuses a missing workflow run", () => {
  const env = { ...process.env };
  delete env.SLIM_WORKFLOW_RUN;
  delete env.GITHUB_RUN_ID;
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      join(ROOT, "scripts/qualify-handoff.ts"),
      "--commit",
      COMMIT,
      "--npm-digest",
      NPM,
      "--action-digest",
      ACTION,
    ],
    { cwd: ROOT, encoding: "utf8", env },
  );
  assert.equal(r.status, EXIT_USAGE);
  assert.match(r.stderr, /workflow-run/);
  assert.equal(r.stdout.trim(), "");
});

test("assertQualifyBundle refuses a missing or mismatched report", () => {
  const work = mkdtempSync(join(tmpdir(), "slim-qr-bundle-"));
  try {
    const tarball = tarStub(join(work, "pack"));
    const bundleDir = join(work, "bundle");
    writeQualifyBundle({
      dir: bundleDir,
      tarball,
      receiptsDir: join(work, "empty"),
      commit: COMMIT,
      npmDigest: NPM,
      actionDigest: ACTION,
      distSha256: "d".repeat(64),
    });
    assert.throws(
      () => assertQualifyBundle({ dir: bundleDir, commit: COMMIT }),
      (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL && /qualify-report/.test(err.message),
    );

    const report = sampleReport({ npmDigest: "e".repeat(64) });
    writeQualifyReport(join(bundleDir, QUALIFY_REPORT_NAME), report);
    assert.throws(
      () => assertQualifyBundle({ dir: bundleDir, commit: COMMIT }),
      (err: unknown) => err instanceof SlimExit && /npmDigest/.test((err as Error).message),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("writeQualifyBundle copies a passing report next to identity", () => {
  const work = mkdtempSync(join(tmpdir(), "slim-qr-copy-"));
  try {
    const tarball = tarStub(join(work, "pack"));
    const receipts = join(work, "receipts");
    mkdirSync(receipts, { recursive: true });
    writeFileSync(join(receipts, "command.scan.json"), "{}\n");
    const report = sampleReport();
    const bundle = writeQualifyBundle({
      dir: join(work, "bundle"),
      tarball,
      receiptsDir: receipts,
      commit: COMMIT,
      npmDigest: NPM,
      actionDigest: ACTION,
      distSha256: "d".repeat(64),
      report,
    });
    const raw = JSON.parse(readFileSync(join(bundle.dir, QUALIFY_REPORT_NAME), "utf8")) as {
      outcome: string;
      workflowRun: string;
    };
    assert.equal(raw.outcome, "pass");
    assert.equal(raw.workflowRun, RUN);
    assert.equal(existsSync(join(bundle.receiptsDir, QUALIFY_REPORT_NAME)), false);
    const ok = assertQualifyBundle({ dir: bundle.dir, commit: COMMIT });
    assert.equal(ok.report?.workflowRun, RUN);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("assertQualifyBundle binds the selected qualification workflow run", () => {
  const work = mkdtempSync(join(tmpdir(), "slim-qr-run-"));
  try {
    const bundleDir = join(work, "bundle");
    const bundle = writeQualifyBundle({
      dir: bundleDir,
      tarball: tarStub(join(work, "pack")),
      receiptsDir: join(work, "receipts"),
      commit: COMMIT,
      npmDigest: NPM,
      actionDigest: ACTION,
      distSha256: "d".repeat(64),
      report: sampleReport(),
    });
    assert.throws(
      () => assertQualifyBundle({ dir: bundle.dir, commit: COMMIT, qualificationRun: "different" }),
      (err: unknown) => err instanceof SlimExit && /qualification run/.test(err.message),
    );
    assertQualifyBundle({ dir: bundle.dir, commit: COMMIT, qualificationRun: RUN });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("live pack helper copies the supplied qualification tarball", () => {
  const work = mkdtempSync(join(tmpdir(), "slim-qr-exact-"));
  const source = tarStub(join(work, "pack"));
  const previous = process.env.SLIM_QUALIFY_TARBALL;
  process.env.SLIM_QUALIFY_TARBALL = source;
  let packed: { packDir: string; tarball: string } | undefined;
  try {
    packed = packSlim();
    assert.notEqual(packed.tarball, source);
    assert.deepEqual(readFileSync(packed.tarball), readFileSync(source));
  } finally {
    if (packed) rmPackedTemp(packed.packDir);
    if (previous === undefined) delete process.env.SLIM_QUALIFY_TARBALL;
    else process.env.SLIM_QUALIFY_TARBALL = previous;
    rmSync(work, { recursive: true, force: true });
  }
});
