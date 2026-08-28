/**
 * MIT License
 *
 * Emit local qualification receipts after named checkIds pass.
 */

import { spawnSync } from "node:child_process";
import { execPm, hermeticPmEnv } from "../rewrite/lockfile.ts";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STAMP_NAME,
  actionDigestFromPack,
  contentDigestOfDir,
  extractNpmPack,
  stampDistSha256,
} from "../release/digest.ts";
import type { InventoryEntry, SupportInventory } from "./inventory.ts";
import { INVENTORY_NODES, INVENTORY_OS } from "./inventory.ts";
import {
  localReceipt,
  writeReceipt,
  type CandidateIdentity,
} from "./receipts.ts";

export type OsCell = (typeof INVENTORY_OS)[number];
export type NodeCell = (typeof INVENTORY_NODES)[number];

export interface OsNodeCell {
  os: OsCell;
  node: NodeCell;
}

export interface CheckResult {
  ok: boolean;
  log: string;
}

export type RunCheck = (checkId: string) => CheckResult;

export interface EmitLocalOpts {
  inventory: SupportInventory;
  receiptsDir: string;
  candidate: CandidateIdentity;
  root: string;
  only?: "osNode";
  runCheck?: RunCheck;
  cell?: OsNodeCell | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  now?: Date;
}

export interface EmitLocalResult {
  written: string[];
  skipped: string[];
  failed: string[];
}

export function runnerOs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): OsCell | null {
  const ga = env.GITHUB_ACTIONS === "1" || env.GITHUB_ACTIONS === "true";
  if (ga) {
    const r = env.RUNNER_OS ?? "";
    if (r === "Linux") return "ubuntu-latest";
    if (r === "macOS") return "macos-latest";
    if (r === "Windows") return "windows-latest";
    return null;
  }
  if (platform === "linux") return "ubuntu-latest";
  if (platform === "darwin") return "macos-latest";
  if (platform === "win32") return "windows-latest";
  return null;
}

export function runnerNode(version = process.version): NodeCell | null {
  const v = version.replace(/^v/, "");
  const [maj, min] = v.split(".");
  if (maj === "22" && min === "18") return "22.18";
  if (maj === "24") return "24";
  return null;
}

export function currentOsNodeCell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  nodeVersion = process.version,
): OsNodeCell | null {
  const os = runnerOs(env, platform);
  const node = runnerNode(nodeVersion);
  if (!os || !node) return null;
  return { os, node };
}

export function defaultRunCheck(root: string, checkId: string): CheckResult {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--test", checkId],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 300_000,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    },
  );
  const log = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  return { ok: r.status === 0, log };
}

function environmentFor(entry: InventoryEntry, platform: string, nodeVersion: string): string {
  const base = `${platform} node-${nodeVersion}`;
  if (entry.kind === "osNode") {
    return `${entry.os} node-${entry.node} ${base}`;
  }
  if (entry.kind === "packageManager" && entry.name) {
    return `${base} ${entry.name}`;
  }
  return base;
}

export function emitLocalReceipts(opts: EmitLocalOpts): EmitLocalResult {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const nodeVersion = opts.nodeVersion ?? process.version;
  const cell =
    opts.cell !== undefined
      ? opts.cell
      : currentOsNodeCell(env, platform, nodeVersion);
  const runCheck =
    opts.runCheck ?? ((checkId: string) => defaultRunCheck(opts.root, checkId));
  const now = opts.now ?? new Date();
  const workflowRun = env.SLIM_WORKFLOW_RUN ?? env.GITHUB_RUN_ID ?? null;

  const entries = opts.inventory.entries.filter((e) => {
    if (e.receiptClass !== "local") return false;
    if (opts.only === "osNode") return e.kind === "osNode";
    return true;
  });

  const byCheck = new Map<string, InventoryEntry[]>();
  for (const e of entries) {
    const list = byCheck.get(e.checkId) ?? [];
    list.push(e);
    byCheck.set(e.checkId, list);
  }

  const checkResults = new Map<string, CheckResult>();
  for (const checkId of byCheck.keys()) {
    const needed = (byCheck.get(checkId) ?? []).some((e) => {
      if (e.kind !== "osNode") return true;
      return Boolean(cell && e.os === cell.os && e.node === cell.node);
    });
    if (!needed) continue;
    checkResults.set(checkId, runCheck(checkId));
  }

  const written: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const e of entries) {
    if (e.kind === "osNode") {
      if (!cell || e.os !== cell.os || e.node !== cell.node) {
        skipped.push(e.id);
        continue;
      }
    }
    const cr = checkResults.get(e.checkId);
    if (!cr || !cr.ok) {
      failed.push(e.id);
      continue;
    }
    const startedAt = now;
    const endedAt = now;
    writeReceipt(
      opts.receiptsDir,
      e.id,
      localReceipt({
        entry: e,
        commit: opts.candidate.commit,
        npmDigest: opts.candidate.npmDigest,
        actionDigest: e.kind === "action" ? opts.candidate.actionDigest : null,
        startedAt,
        endedAt,
        log: cr.log,
        environment: environmentFor(e, platform, nodeVersion),
        workflowRun,
      }),
    );
    written.push(e.id);
  }

  return { written, skipped, failed };
}

export function collectOsNodeReceipts(fromDir: string, receiptsDir: string): string[] {
  mkdirSync(receiptsDir, { recursive: true });
  const copied: string[] = [];
  const stack = [fromDir];
  while (stack.length) {
    const dir = stack.pop()!;
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!/^osNode\..+\.json$/.test(name)) continue;
      const dest = join(receiptsDir, name);
      if (p !== dest) cpSync(p, dest);
      copied.push(name);
    }
  }
  return copied.sort();
}

export function packAndDigest(root: string): {
  packDir: string;
  tarball: string;
  npmDigest: string;
  actionDigest: string;
  distSha256: string;
} {
  const packDir = mkdtempSync(join(tmpdir(), "slim-qualify-pack-"));
  const tgz = String(
    execPm("npm", ["pack", "--ignore-scripts", `--pack-destination=${packDir}`], {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      env: hermeticPmEnv({ COPYFILE_DISABLE: "1" }),
    }),
  ).trim();
  const name = tgz.split("\n").pop() ?? tgz;
  if (!name) throw new Error("npm pack produced no tarball name");
  const tarball = join(packDir, name);
  const dest = mkdtempSync(join(tmpdir(), "slim-qualify-extract-"));
  try {
    const packRoot = extractNpmPack(tarball, dest);
    const distSha256 = stampDistSha256(packRoot);
    if (!distSha256 || !/^[0-9a-f]{64}$/.test(distSha256)) {
      throw new Error(`packed dist/${STAMP_NAME} is missing sha256`);
    }
    return {
      packDir,
      tarball,
      npmDigest: contentDigestOfDir(packRoot),
      actionDigest: actionDigestFromPack(packRoot),
      distSha256,
    };
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

export function removePackDir(packDir: string): void {
  rmSync(packDir, { recursive: true, force: true });
}
