#!/usr/bin/env node
/**
 * Versioned size/parse receipts for public claims.
 * Bytes and gzip are stable. parseNs is measured on this machine and labeled.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { platform } from "node:os";
import { KNOWN_MIN_BYTES } from "../src/size/estimate.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export type Provenance = "measured" | "estimated";

export interface MeasuredFile {
  path: string;
  bytes: { value: number; provenance: Provenance };
  gzipBytes: { value: number; provenance: Provenance };
  parseNs: { value: number; provenance: Provenance };
}

export interface ClaimsDoc {
  slimVersion: string;
  node: string;
  os: string;
  date: string;
  notes: string;
  files: Record<string, MeasuredFile>;
  estimatedOriginalMin: {
    lodash: { value: number; provenance: "estimated"; source: string };
  };
}

async function parseNs(file: string): Promise<number> {
  const href = pathToFileURL(file).href;
  const t0 = process.hrtime.bigint();
  await import(href + `?t=${t0}`);
  return Number(process.hrtime.bigint() - t0);
}

export async function measureClaims(root = ROOT): Promise<ClaimsDoc> {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const slice = join(root, "fixtures/lodash-get-debounce/src/slim/lodash.ts");
  const lodashEntry = join(root, "node_modules/lodash/lodash.js");
  const files: Record<string, MeasuredFile> = {};

  async function one(key: string, path: string): Promise<void> {
    const buf = readFileSync(path);
    const gz = gzipSync(buf);
    files[key] = {
      path: path.slice(root.length + 1),
      bytes: { value: buf.length, provenance: "measured" },
      gzipBytes: { value: gz.length, provenance: "measured" },
      parseNs: { value: await parseNs(path), provenance: "measured" },
    };
  }

  await one("goldenLodashSlice", slice);
  if (existsSync(lodashEntry)) {
    await one("lodashOracleEntry", lodashEntry);
  }

  return {
    slimVersion: pkg.version,
    node: process.versions.node,
    os: platform(),
    date: new Date().toISOString().slice(0, 10),
    notes:
      "Node parse/size of the golden lodash slice vs installed lodash.js. Worker isolate CPU is a vendor budget, not measured here. originalMin is Bundlephobia-ish table, estimated.",
    files,
    estimatedOriginalMin: {
      lodash: {
        value: KNOWN_MIN_BYTES.lodash ?? 0,
        provenance: "estimated",
        source: "src/size/estimate.ts KNOWN_MIN_BYTES",
      },
    },
  };
}

export function writeClaims(doc: ClaimsDoc, root = ROOT): string {
  const out = join(root, "docs/measurements.json");
  writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  return out;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const doc = await measureClaims();
  const out = writeClaims(doc);
  process.stdout.write(`wrote ${out} sliceBytes=${doc.files.goldenLodashSlice?.bytes.value}\n`);
}
