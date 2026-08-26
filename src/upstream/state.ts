import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { standingTestPaths } from "../check.ts";
import { ENVELOPE_VERSION, hashEnvelope, type Envelope } from "../envelope/types.ts";
import { EXIT_FAIL, SlimExit } from "../exit.ts";

export interface ReplacementRecord {
  version: string;
  envelopeHash: string;
  symbols: string[];
  module: string;
}

export function assertReplacementState(
  root: string,
  pkg: string,
  rec: ReplacementRecord,
  outDir: string,
): Envelope {
  if (!rec.version || !rec.envelopeHash || !Array.isArray(rec.symbols) || !rec.module) {
    throw new SlimExit(EXIT_FAIL, `malformed manifest replacement for ${pkg}`);
  }
  const envPath = join(root, ".slim", pkg, "envelope.json");
  if (!existsSync(envPath)) {
    throw new SlimExit(EXIT_FAIL, `missing envelope ${envPath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(envPath, "utf8"));
  } catch {
    throw new SlimExit(EXIT_FAIL, `malformed envelope ${envPath}`);
  }
  if (!raw || typeof raw !== "object") {
    throw new SlimExit(EXIT_FAIL, `malformed envelope ${envPath}`);
  }
  const env = raw as Envelope;
  if (env.schemaVersion !== ENVELOPE_VERSION) {
    throw new SlimExit(
      EXIT_FAIL,
      `schema-incompatible envelope ${envPath}: schemaVersion ${String(env.schemaVersion)}`,
    );
  }
  if (!env.package?.name || env.package.name !== pkg) {
    throw new SlimExit(EXIT_FAIL, `envelope package name mismatch in ${envPath}`);
  }
  if (!Array.isArray(env.symbols) || !env.closure) {
    throw new SlimExit(EXIT_FAIL, `malformed envelope ${envPath}`);
  }
  let hash: string;
  try {
    hash = hashEnvelope(env);
  } catch {
    throw new SlimExit(EXIT_FAIL, `malformed envelope ${envPath}`);
  }
  if (hash !== rec.envelopeHash) {
    throw new SlimExit(EXIT_FAIL, `manifest envelopeHash does not match envelope for ${pkg}`);
  }
  const evidencePath = join(root, ".slim", pkg, "evidence.json");
  if (!existsSync(evidencePath)) {
    throw new SlimExit(EXIT_FAIL, `missing evidence ${evidencePath}`);
  }
  try {
    const ev = JSON.parse(readFileSync(evidencePath, "utf8")) as { envelopeHash?: string };
    if (ev.envelopeHash !== hash) {
      throw new SlimExit(EXIT_FAIL, `evidence.json envelopeHash does not match envelope for ${pkg}`);
    }
  } catch (err) {
    if (err instanceof SlimExit) throw err;
    throw new SlimExit(EXIT_FAIL, `malformed evidence ${evidencePath}`);
  }
  const moduleAbs = join(root, rec.module);
  if (!existsSync(moduleAbs)) {
    throw new SlimExit(EXIT_FAIL, `missing slice module ${rec.module}`);
  }
  const standing = standingTestPaths(root, pkg, outDir);
  if (!existsSync(standing.tsAbs) && !existsSync(standing.jsAbs)) {
    throw new SlimExit(EXIT_FAIL, `missing standing tests for ${pkg}`);
  }
  return env;
}
