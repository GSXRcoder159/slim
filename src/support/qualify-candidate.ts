/**
 * MIT License
 *
 * Candidate qualification: identity, pack, local emit, optional live, inventory gate.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { EXIT_FAIL, EXIT_REFUSED, SlimExit } from "../exit.ts";
import {
  EXPECTED_REGISTRY,
  assertCleanTree,
  assertMigrationGuidance,
  assertPackageIdentity,
  assertRegistry,
  assertVersionIdentity,
  assertWorkflowPermissions,
  packageVersion,
  readReleaseWorkflow,
  versionTag,
} from "../release/identity.ts";
import {
  collectOsNodeReceipts,
  emitLocalReceipts,
  packAndDigest,
  removePackDir,
  type RunCheck,
} from "./emit-local.ts";
import { loadInventory } from "./inventory.ts";
import {
  qualifyInventory,
  type CandidateIdentity,
  type QualifyFailure,
} from "./receipts.ts";

export const LIVE_GATES = [
  { env: "SLIM_LLM_LIVE", file: "test/llm-live.test.ts" },
  { env: "SLIM_UPSTREAM_LIVE", file: "test/upstream-live.test.ts" },
  { env: "SLIM_PR_LIVE", file: "test/github/pr-live.test.ts" },
  { env: "SLIM_ACTION_LIVE", file: "test/github/action-live.test.ts" },
  { env: "SLIM_RELEASE_LIVE", file: "test/release-live.test.ts" },
] as const;

export type QualifyMode = "emit" | "collect";

export function liveTestFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  return LIVE_GATES.filter((g) => env[g.env] === "1").map((g) => g.file);
}

export interface QualifyCandidateOpts {
  root: string;
  mode: QualifyMode;
  receiptsDir: string;
  commit: string;
  npmDigest?: string | null;
  actionDigest?: string | null;
  workflowRun?: string | null;
  fromDir?: string;
  osNodeOnly?: boolean;
  registryUrl?: string;
  env?: NodeJS.ProcessEnv;
  runCheck?: RunCheck;
  pack?: () => { npmDigest: string; actionDigest: string; packDir?: string };
  runLiveFiles?: (files: string[], env: NodeJS.ProcessEnv) => void;
}

export interface QualifyCandidateResult {
  failures: QualifyFailure[];
  npmDigest: string | null;
  actionDigest: string | null;
  workflowRun: string | null;
  written: string[];
}

export function resolveWorkflowRun(
  opts: { workflowRun?: string | null },
  env: NodeJS.ProcessEnv,
): string | null {
  const raw = opts.workflowRun ?? env.SLIM_WORKFLOW_RUN ?? env.GITHUB_RUN_ID ?? null;
  if (raw == null || raw === "") return null;
  return raw;
}

function defaultRunLive(root: string, files: string[], env: NodeJS.ProcessEnv): void {
  if (!files.length) return;
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--test", ...files],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 600_000,
      env,
    },
  );
  if (r.status !== 0) {
    throw new SlimExit(
      EXIT_FAIL,
      `live checks failed\n${r.stdout ?? ""}\n${r.stderr ?? ""}`,
    );
  }
}

export function runQualifyCandidate(opts: QualifyCandidateOpts): QualifyCandidateResult {
  const env = opts.env ?? process.env;
  const inventory = loadInventory();
  const written: string[] = [];
  const workflowRun = resolveWorkflowRun(opts, env);

  if (opts.mode === "collect") {
    const fromDir = opts.fromDir ?? opts.receiptsDir;
    collectOsNodeReceipts(fromDir, opts.receiptsDir);
    const candidate: CandidateIdentity = {
      commit: opts.commit,
      npmDigest: opts.npmDigest ?? env.SLIM_NPM_DIGEST ?? null,
      actionDigest: opts.actionDigest ?? env.SLIM_ACTION_DIGEST ?? null,
      workflowRun,
    };
    const scoped = opts.osNodeOnly
      ? { schemaVersion: 1 as const, entries: inventory.entries.filter((e) => e.kind === "osNode") }
      : inventory;
    return {
      failures: qualifyInventory(scoped, opts.receiptsDir, candidate, { root: opts.root }),
      npmDigest: candidate.npmDigest,
      actionDigest: candidate.actionDigest,
      workflowRun,
      written,
    };
  }

  assertCleanTree(opts.root);
  assertVersionIdentity({ root: opts.root, tag: versionTag(packageVersion(opts.root)) });
  assertMigrationGuidance(opts.root);
  assertPackageIdentity(opts.root);
  assertRegistry(opts.registryUrl ?? env.npm_config_registry ?? EXPECTED_REGISTRY);
  assertWorkflowPermissions(readReleaseWorkflow(opts.root));

  let packDir: string | undefined;
  let npmDigest = opts.npmDigest ?? env.SLIM_NPM_DIGEST ?? null;
  let actionDigest = opts.actionDigest ?? env.SLIM_ACTION_DIGEST ?? null;
  if (!npmDigest || !actionDigest) {
    const packed = opts.pack ? opts.pack() : packAndDigest(opts.root);
    npmDigest = packed.npmDigest;
    actionDigest = packed.actionDigest;
    packDir = packed.packDir;
  }

  try {
    const candidate: CandidateIdentity = {
      commit: opts.commit,
      npmDigest,
      actionDigest,
      workflowRun,
    };
    const emitEnv = workflowRun ? { ...env, SLIM_WORKFLOW_RUN: workflowRun } : env;
    const emitted = emitLocalReceipts({
      inventory,
      receiptsDir: opts.receiptsDir,
      candidate,
      root: opts.root,
      runCheck: opts.runCheck,
      env: emitEnv,
    });
    written.push(...emitted.written);
    if (emitted.failed.length) {
      const logs = Object.entries(emitted.failedLogs)
        .map(([checkId, log]) => `${checkId}\n${log}`)
        .join("\n");
      throw new SlimExit(
        EXIT_FAIL,
        `local checks failed: ${emitted.failed.join(", ")}${logs ? `\n${logs}` : ""}`,
      );
    }

    const liveFiles = liveTestFiles(env);
    if (liveFiles.length) {
      const liveEnv: NodeJS.ProcessEnv = {
        ...emitEnv,
        SLIM_RECEIPTS_DIR: opts.receiptsDir,
        SLIM_CANDIDATE_COMMIT: opts.commit,
        SLIM_NPM_DIGEST: npmDigest ?? "",
        SLIM_ACTION_DIGEST: actionDigest ?? "",
      };
      if (workflowRun) liveEnv.SLIM_WORKFLOW_RUN = workflowRun;
      const runLive = opts.runLiveFiles ?? ((files, e) => defaultRunLive(opts.root, files, e));
      runLive(liveFiles, liveEnv);
    }

    const scoped = opts.osNodeOnly
      ? { schemaVersion: 1 as const, entries: inventory.entries.filter((e) => e.kind === "osNode") }
      : inventory;
    return {
      failures: qualifyInventory(scoped, opts.receiptsDir, candidate, { root: opts.root }),
      npmDigest,
      actionDigest,
      workflowRun,
      written,
    };
  } finally {
    if (packDir && existsSync(packDir)) removePackDir(packDir);
  }
}

export function throwIfUnqualified(failures: QualifyFailure[]): void {
  if (!failures.length) return;
  const lines = failures.map((f) => `${f.entryId}: ${f.reason}`).join("\n");
  throw new SlimExit(EXIT_FAIL, `stale or missing receipts\n${lines}`);
}

export function requireCommit(commit: string | undefined): string {
  if (!commit || commit.length !== 40 || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new SlimExit(EXIT_REFUSED, "qualify-candidate: --commit (40-char sha) is required");
  }
  return commit;
}
