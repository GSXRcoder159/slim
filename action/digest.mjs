/**
 * Action distributable identity. Hashes committed wrappers plus compiled
 * dist (except the build stamp). Used by the runner, the build stamp, and tests.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const STAMP_NAME = ".slim-build.json";

export const ACTION_WRAPPERS = [
  "action/check/action.yml",
  "action/bloat/action.yml",
  "action/upstream/action.yml",
  "action/run.mjs",
  "action/digest.mjs",
];

function walkFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

export function actionManifest(root) {
  const files = [...ACTION_WRAPPERS];
  const dist = join(root, "dist");
  for (const p of walkFiles(dist)) {
    const rel = relative(root, p).replace(/\\/g, "/");
    if (rel === `dist/${STAMP_NAME}`) continue;
    files.push(rel);
  }
  files.sort();
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f);
    h.update("\0");
    h.update(readFileSync(join(root, f)));
  }
  return { files, sha256: h.digest("hex") };
}

const ACTION_NAMES = {
  check: "check-action",
  bloat: "bloat-action",
  upstream: "upstream-action",
};

export function verifyActionDistributable(root, cmd, pin) {
  const rel = ACTION_NAMES[cmd];
  if (!rel) {
    return { ok: false, exit: 2, message: "usage: run.mjs <check|bloat|upstream>" };
  }
  const dist = join(root, "dist/github", `${rel}.js`);
  if (!existsSync(dist)) {
    return {
      ok: false,
      exit: 4,
      message: `slim action ${cmd}: missing dist/github/${rel}.js under ${root}`,
    };
  }
  const stampPath = join(root, "dist", STAMP_NAME);
  if (!existsSync(stampPath)) {
    return {
      ok: false,
      exit: 4,
      message: `slim action ${cmd}: missing dist/${STAMP_NAME} under ${root}`,
    };
  }
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(stampPath, "utf8"));
  } catch {
    return {
      ok: false,
      exit: 4,
      message: `slim action ${cmd}: invalid dist/${STAMP_NAME} under ${root}`,
    };
  }
  if (typeof stamp?.actionSha256 !== "string" || !/^[0-9a-f]{64}$/.test(stamp.actionSha256)) {
    return {
      ok: false,
      exit: 4,
      message: `slim action ${cmd}: missing action identity in dist/${STAMP_NAME}`,
    };
  }
  const { sha256 } = actionManifest(root);
  if (sha256 !== stamp.actionSha256) {
    return {
      ok: false,
      exit: 4,
      message: `slim action ${cmd}: stale action distributable`,
    };
  }
  if (pin && pin !== sha256) {
    return {
      ok: false,
      exit: 4,
      message: `slim action ${cmd}: action digest mismatch`,
    };
  }
  return { ok: true, dist, sha256 };
}
