#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STAMP_NAME = ".slim-build.json";

export function repoRootFromScript(metaUrl = import.meta.url) {
  return join(dirname(fileURLToPath(metaUrl)), "..");
}

function walkFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

function tscBin(root) {
  const local = join(root, "node_modules", "typescript", "bin", "tsc");
  if (existsSync(local)) return local;
  const fromRepo = join(repoRootFromScript(), "node_modules", "typescript", "bin", "tsc");
  if (existsSync(fromRepo)) return fromRepo;
  return null;
}

function sourcePathForDistFile(root, rel) {
  if (rel === STAMP_NAME) return { keep: true };
  if (rel.startsWith("generate/catalog/") && rel.endsWith(".ts")) {
    return { src: join(root, "src", rel) };
  }
  let stem = rel;
  if (stem.endsWith(".d.ts")) stem = stem.slice(0, -".d.ts".length);
  else if (stem.endsWith(".js.map")) stem = stem.slice(0, -".js.map".length);
  else if (stem.endsWith(".js")) stem = stem.slice(0, -".js".length);
  else return { src: null };
  return { src: join(root, "src", `${stem}.ts`) };
}

function removeOrphans(root) {
  const dist = join(root, "dist");
  for (const file of walkFiles(dist)) {
    const rel = relative(dist, file).replace(/\\/g, "/");
    const mapped = sourcePathForDistFile(root, rel);
    if (mapped.keep) continue;
    if (mapped.src && existsSync(mapped.src)) continue;
    rmSync(file, { force: true });
  }
}

export function copyPackAssets(root) {
  const catalogSrc = join(root, "src/generate/catalog");
  const catalogDest = join(root, "dist/generate/catalog");
  if (existsSync(catalogSrc)) {
    mkdirSync(catalogDest, { recursive: true });
    const srcNames = new Set(readdirSync(catalogSrc).filter((n) => n.endsWith(".ts")));
    for (const name of srcNames) {
      copyFileSync(join(catalogSrc, name), join(catalogDest, name));
    }
    if (existsSync(catalogDest)) {
      for (const name of readdirSync(catalogDest)) {
        if (name.endsWith(".ts") && !srcNames.has(name)) {
          rmSync(join(catalogDest, name), { force: true });
        }
      }
    }
  }
  const schemaSrc = join(root, "docs/slim.schema.json");
  if (existsSync(schemaSrc)) {
    copyFileSync(schemaSrc, join(root, "slim.schema.json"));
  }
}

export function distManifest(root) {
  const dist = join(root, "dist");
  const files = walkFiles(dist)
    .map((p) => relative(dist, p).replace(/\\/g, "/"))
    .filter((f) => f !== STAMP_NAME)
    .sort();
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f);
    h.update("\0");
    h.update(readFileSync(join(dist, f)));
  }
  return { files, sha256: h.digest("hex") };
}

export function writeStamp(root) {
  const manifest = distManifest(root);
  writeFileSync(
    join(root, "dist", STAMP_NAME),
    `${JSON.stringify({ ok: true, ...manifest }, null, 2)}\n`,
  );
}

export function assertPackReady(root) {
  const stampPath = join(root, "dist", STAMP_NAME);
  if (!existsSync(stampPath)) {
    process.stderr.write(`slim build: missing dist/${STAMP_NAME}; dist is not a qualified artifact\n`);
    process.exit(1);
  }
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(stampPath, "utf8"));
  } catch {
    process.stderr.write(`slim build: invalid dist/${STAMP_NAME}; dist is not a qualified artifact\n`);
    process.exit(1);
  }
  if (stamp?.ok !== true) {
    process.stderr.write(`slim build: dist/${STAMP_NAME} is not ok; dist is not a qualified artifact\n`);
    process.exit(1);
  }
}

export function build(root) {
  const dist = join(root, "dist");
  const stampPath = join(dist, STAMP_NAME);
  const bin = tscBin(root);
  if (!bin) {
    process.stderr.write("slim build: typescript is not installed (devDependency)\n");
    process.exit(1);
  }
  const tsconfig = join(root, "tsconfig.json");
  const tsc = spawnSync(process.execPath, [bin, "-p", tsconfig], {
    cwd: root,
    stdio: "inherit",
  });
  if (tsc.status !== 0) {
    rmSync(stampPath, { force: true });
    process.exit(tsc.status ?? 1);
  }
  // ponytail: in-place emit + orphan delete. A full dist wipe races parallel test prepacks.
  removeOrphans(root);
  copyPackAssets(root);
  writeStamp(root);
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMain()) {
  const args = process.argv.slice(2);
  const assertOnly = args.includes("--assert");
  const rootArg = args.find((a) => a !== "--assert");
  const root = resolve(rootArg ?? repoRootFromScript());
  if (assertOnly) assertPackReady(root);
  else build(root);
}
