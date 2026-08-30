/**
 * MIT License
 *
 * Release gate: identity, occupancy, bundle, qualify, tarball publish, tag attach.
 */

import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_ENV, EXIT_FAIL, EXIT_REFUSED, SlimExit } from "../exit.ts";
import { cmdShim, cmdShimSpawnOpts } from "../rewrite/lockfile.ts";
import { loadInventory } from "../support/inventory.ts";
import { qualifyInventory } from "../support/receipts.ts";
import { attachCompiledTree, pushReleaseTags, rollbackAttach, type AttachResult } from "./attach.ts";
import { assertQualifyBundle } from "./bundle.ts";
import {
  ACTION_WRAPPERS,
  STAMP_NAME,
  actionDigestFromPack,
  contentDigestOfDir,
  extractNpmPack,
  stampActionSha256,
} from "./digest.ts";
import {
  EXPECTED_REGISTRY,
  assertCleanTree,
  assertPackageIdentity,
  assertPublishRef,
  assertRegistry,
  assertVersionIdentity,
  assertWorkflowPermissions,
  floatingTag,
  packageVersion,
  readReleaseWorkflow,
  versionTag,
} from "./identity.ts";
import { assertNpmOccupancy, type OccupancyFetch } from "./occupancy.ts";

export type GateMode = "identity" | "artifacts" | "rehearse" | "publish";

export type ExecFileFn = (
  file: string,
  args?: readonly string[],
  options?: ExecFileSyncOptions,
) => string | Buffer;

export interface ArtifactIdentity {
  npmDigest: string;
  actionDigest: string;
}

export interface GateOpts {
  root: string;
  mode: GateMode;
  tag?: string;
  tarball?: string;
  receiptsDir?: string;
  bundleDir?: string;
  commit?: string;
  workflowRun?: string | null;
  registryUrl?: string;
  parentSha?: string;
  remote?: string;
  deleteTarball?: boolean;
  occupancyFetch?: OccupancyFetch;
  occupancyWhoami?: () => string;
  occupancyToken?: string | null;
  eventName?: string;
  gitRef?: string;
  now?: Date;
}

export type PublicationOutcome = "none" | "dry-run" | "published";
export type RollbackOutcome = "none" | "restored" | "tags-not-pushed";

export interface GateResult {
  version: string;
  tag: string;
  floatingTag: string;
  npmDigest: string | null;
  actionDigest: string | null;
  attached: AttachResult | null;
  publication: PublicationOutcome;
  rollback: RollbackOutcome;
}

function defaultExec(
  file: string,
  args: readonly string[] = [],
  options?: ExecFileSyncOptions,
): string | Buffer {
  return execFileSync(file, [...args], options);
}

export function resolveTag(root: string, tag?: string): string {
  if (tag) return tag;
  const ref = process.env.GITHUB_REF ?? "";
  const m = ref.match(/^refs\/tags\/(.+)$/);
  if (m?.[1]) return m[1];
  return versionTag(packageVersion(root));
}

export function resolveCommit(
  root: string,
  supplied: string | undefined,
  execFile: ExecFileFn,
): string {
  const head = String(
    execFile("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }),
  ).trim();
  const want = supplied ?? process.env.SLIM_CANDIDATE_COMMIT ?? process.env.GITHUB_SHA;
  if (want && want !== head) {
    throw new SlimExit(EXIT_REFUSED, `commit ${want} does not match HEAD ${head}`);
  }
  return head;
}

export function assertIdentity(root: string, tag: string, registryUrl?: string): void {
  assertVersionIdentity({ root, tag });
  assertCleanTree(root);
  assertPackageIdentity(root);
  assertRegistry(registryUrl ?? process.env.npm_config_registry ?? EXPECTED_REGISTRY);
  assertWorkflowPermissions(readReleaseWorkflow(root));
}

export function assertTarballMatchesRoot(tarball: string, root: string): ArtifactIdentity {
  if (!existsSync(tarball)) {
    throw new SlimExit(EXIT_FAIL, `missing tarball ${tarball}`);
  }
  const dest = mkdtempSync(join(tmpdir(), "slim-rel-art-"));
  try {
    const packRoot = extractNpmPack(tarball, dest);
    const npmDigest = contentDigestOfDir(packRoot);
    const actionDigest = actionDigestFromPack(packRoot);
    const stamp = stampActionSha256(packRoot);
    if (!stamp || !/^[0-9a-f]{64}$/.test(stamp)) {
      throw new SlimExit(EXIT_FAIL, "packed dist/.slim-build.json is missing actionSha256");
    }
    if (stamp !== actionDigest) {
      throw new SlimExit(EXIT_FAIL, "packed Action digest does not match dist stamp");
    }
    for (const rel of ACTION_WRAPPERS) {
      const packed = join(packRoot, rel);
      const current = join(root, rel);
      if (!existsSync(packed) || !existsSync(current)) {
        throw new SlimExit(EXIT_FAIL, `Action wrapper ${rel} missing from checkout or tarball`);
      }
      if (!readFileSync(packed).equals(readFileSync(current))) {
        throw new SlimExit(EXIT_FAIL, `Action wrapper ${rel} does not match packed artifact`);
      }
    }
    // Release checks out source only (dist is gitignored). Commit + identity bind the tarball.
    // When the tree includes a compiled stamp, the full Action digest must still match.
    if (existsSync(join(root, "dist", STAMP_NAME))) {
      const current = actionDigestFromPack(root);
      if (current !== actionDigest) {
        throw new SlimExit(
          EXIT_FAIL,
          "Action digest mismatch: current tree is not the packed artifact",
        );
      }
    }
    return { npmDigest, actionDigest };
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

export function npmPublishArgs(
  tarball: string,
  opts: { dryRun: boolean; provenance: boolean },
): string[] {
  const args = ["publish", tarball];
  if (opts.dryRun) args.push("--dry-run");
  if (opts.provenance) args.push("--provenance");
  return args;
}

/** npm 11 fail-closes dry-run when the version is already on the registry. */
export function isDryRunVersionConflict(msg: string): boolean {
  return /cannot publish over the previously published versions/i.test(msg);
}

export function npmPublishTarball(
  tarball: string,
  opts: { dryRun: boolean; provenance: boolean; cwd: string; env?: NodeJS.ProcessEnv },
  execFile: ExecFileFn = defaultExec,
): void {
  if (!existsSync(tarball)) {
    throw new SlimExit(EXIT_FAIL, `missing tarball ${tarball}`);
  }
  if (!opts.dryRun && process.env.GITHUB_ACTIONS !== "1") {
    throw new SlimExit(EXIT_ENV, "refusing to publish outside GitHub Actions");
  }
  try {
    const bin = cmdShim("npm");
    execFile(bin, npmPublishArgs(tarball, opts), {
      cwd: opts.cwd,
      encoding: "utf8",
      env: opts.env ?? process.env,
      ...cmdShimSpawnOpts(bin),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.dryRun && isDryRunVersionConflict(msg)) {
      throw new SlimExit(EXIT_REFUSED, `npm version is already published (occupied): ${msg}`);
    }
    if (err instanceof SlimExit) throw err;
    throw new SlimExit(EXIT_FAIL, `npm publish failed: ${msg}`);
  }
}

function qualifyOrThrow(
  receiptsDir: string,
  candidate: { commit: string; npmDigest: string; actionDigest: string; workflowRun: string | null },
): void {
  const failures = qualifyInventory(loadInventory(), receiptsDir, {
    commit: candidate.commit,
    npmDigest: candidate.npmDigest,
    actionDigest: candidate.actionDigest,
    workflowRun: candidate.workflowRun,
  });
  if (failures.length) {
    const lines = failures.map((f) => `${f.entryId}: ${f.reason}`).join("\n");
    throw new SlimExit(EXIT_FAIL, `stale or missing receipts\n${lines}`);
  }
}

export async function runReleaseGate(
  opts: GateOpts,
  execFile: ExecFileFn = defaultExec,
): Promise<GateResult> {
  const tag = resolveTag(opts.root, opts.tag);
  assertIdentity(opts.root, tag, opts.registryUrl);
  assertPublishRef({
    mode: opts.mode,
    tag,
    eventName: opts.eventName,
    ref: opts.gitRef,
  });
  const version = packageVersion(opts.root);
  await assertNpmOccupancy({
    version,
    registryUrl: opts.registryUrl ?? EXPECTED_REGISTRY,
    fetch: opts.occupancyFetch,
    whoami: opts.occupancyWhoami,
    token: opts.occupancyToken,
  });
  const float = floatingTag(version);
  const result: GateResult = {
    version,
    tag,
    floatingTag: float,
    npmDigest: null,
    actionDigest: null,
    attached: null,
    publication: "none",
    rollback: "none",
  };
  if (opts.mode === "identity") return result;

  const commit = resolveCommit(opts.root, opts.commit, execFile);
  const workflowRun =
    opts.workflowRun ?? process.env.SLIM_WORKFLOW_RUN ?? process.env.GITHUB_RUN_ID ?? null;

  let tarball = opts.tarball;
  let receiptsDir = opts.receiptsDir;
  if (opts.mode === "publish" && !opts.bundleDir) {
    throw new SlimExit(EXIT_REFUSED, "publish requires --bundle (qualification-bundle)");
  }
  if (opts.bundleDir) {
    const bundle = assertQualifyBundle({
      dir: opts.bundleDir,
      commit,
      now: opts.now,
    });
    tarball = bundle.tarball;
    receiptsDir = bundle.receiptsDir;
    const artifacts = assertTarballMatchesRoot(tarball, opts.root);
    if (artifacts.npmDigest !== bundle.identity.npmDigest) {
      throw new SlimExit(EXIT_FAIL, "bundle npmDigest does not match tarball contents");
    }
    if (artifacts.actionDigest !== bundle.identity.actionDigest) {
      throw new SlimExit(EXIT_FAIL, "bundle actionDigest does not match tarball contents");
    }
    result.npmDigest = artifacts.npmDigest;
    result.actionDigest = artifacts.actionDigest;
  } else {
    if (!tarball) {
      throw new SlimExit(EXIT_REFUSED, "release gate artifacts mode requires --tarball");
    }
    const artifacts = assertTarballMatchesRoot(tarball, opts.root);
    result.npmDigest = artifacts.npmDigest;
    result.actionDigest = artifacts.actionDigest;
  }

  if (opts.mode === "publish" || receiptsDir) {
    qualifyOrThrow(receiptsDir ?? "qualification/receipts", {
      commit,
      npmDigest: result.npmDigest!,
      actionDigest: result.actionDigest!,
      workflowRun,
    });
  }

  if (opts.mode === "artifacts") {
    return result;
  }

  const provenance = process.env.GITHUB_ACTIONS === "1";
  npmPublishTarball(
    tarball!,
    { dryRun: true, provenance, cwd: opts.root },
    execFile,
  );
  result.publication = "dry-run";

  const dest = mkdtempSync(join(tmpdir(), "slim-rel-pack-"));
  try {
    const packRoot = extractNpmPack(tarball!, dest);
    const parentSha =
      opts.parentSha ??
      process.env.GITHUB_SHA ??
      String(execFile("git", ["rev-parse", "HEAD"], { cwd: opts.root, encoding: "utf8" })).trim();
    const attached = attachCompiledTree(
      {
        gitRoot: opts.root,
        packRoot,
        parentSha,
        versionTag: tag,
        floatingTag: float,
        push: false,
        remote: opts.remote,
      },
      execFile,
    );
    result.attached = attached;
    if (opts.mode === "rehearse") {
      rollbackAttach(attached, opts.root, execFile);
      result.attached = null;
      result.rollback = "restored";
    } else {
      try {
        npmPublishTarball(
          tarball!,
          { dryRun: false, provenance: true, cwd: opts.root },
          execFile,
        );
      } catch (err) {
        rollbackAttach(attached, opts.root, execFile);
        result.attached = null;
        result.rollback = "restored";
        throw err;
      }
      result.publication = "published";
      try {
        pushReleaseTags(attached, opts.root, opts.remote ?? "origin", execFile);
      } catch (err) {
        result.rollback = "tags-not-pushed";
        throw new SlimExit(
          EXIT_FAIL,
          `npm published but tag push failed (retry tag push only): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      result.rollback = "none";
    }
  } finally {
    rmSync(dest, { recursive: true, force: true });
    if (opts.deleteTarball && tarball && existsSync(tarball) && !opts.bundleDir) {
      rmSync(tarball, { force: true });
    }
  }
  return result;
}
