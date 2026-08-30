import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { hermeticPmEnv, spawnPm, cmdShimSpawnOpts } from "../src/rewrite/lockfile.ts";
import { withRepoDistLock } from "./helpers/llm-replace.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const STAMP = join(DIST, ".slim-build.json");
const BUILD = join(ROOT, "scripts/build.mjs");

function walkFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

function distManifest(root = DIST): { files: string[]; sha256: string } {
  const files = walkFiles(root)
    .map((p) => relative(root, p).replace(/\\/g, "/"))
    .filter((f) => f !== ".slim-build.json")
    .sort();
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f);
    h.update("\0");
    h.update(readFileSync(join(root, f)));
  }
  return { files, sha256: h.digest("hex") };
}

function runBuild(cwd: string, extraArgs: string[] = []): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync(process.execPath, [BUILD, ...extraArgs], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env },
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function parseNpmJson(text: string): unknown {
  const startObj = text.indexOf("{");
  const startArr = text.indexOf("[");
  const start =
    startArr >= 0 && (startObj < 0 || startArr < startObj) ? startArr : startObj;
  assert.ok(start >= 0, `npm JSON missing in output:\n${text.slice(0, 500)}`);
  return JSON.parse(text.slice(start));
}

function npmJson(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnPm("npm", args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: hermeticPmEnv(),
  });
  return { status: r.status ?? 1, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
}

function stampOf(root = ROOT): {
  ok: boolean;
  files: string[];
  sha256: string;
  actionSha256?: string;
} {
  return JSON.parse(readFileSync(join(root, "dist", ".slim-build.json"), "utf8")) as {
    ok: boolean;
    files: string[];
    sha256: string;
    actionSha256?: string;
  };
}

test("build wipes stale dist outputs after a source module is removed", { timeout: 120_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "slim-orphan-src-"));
  try {
    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(join(tmp, "docs"), { recursive: true });
    writeFileSync(
      join(tmp, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: "dist",
          rootDir: "src",
          declaration: true,
          sourceMap: true,
          noEmitOnError: true,
          skipLibCheck: true,
        },
        include: ["src/**/*.ts"],
      }),
    );
    writeFileSync(join(tmp, "docs", "slim.schema.json"), "{}\n");
    writeFileSync(join(tmp, "src", "keep.ts"), "export const keep = 1;\n");
    writeFileSync(join(tmp, "src", "gone.ts"), "export const gone = 2;\n");
    const first = runBuild(tmp, [tmp]);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.ok(existsSync(join(tmp, "dist", "keep.js")));
    assert.ok(existsSync(join(tmp, "dist", "gone.js")));
    assert.ok(existsSync(join(tmp, "dist", "gone.d.ts")));
    assert.ok(existsSync(join(tmp, "dist", "gone.js.map")));
    rmSync(join(tmp, "src", "gone.ts"));
    const second = runBuild(tmp, [tmp]);
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.ok(existsSync(join(tmp, "dist", "keep.js")));
    assert.equal(existsSync(join(tmp, "dist", "gone.js")), false);
    assert.equal(existsSync(join(tmp, "dist", "gone.d.ts")), false);
    assert.equal(existsSync(join(tmp, "dist", "gone.js.map")), false);
    writeFileSync(join(tmp, "dist", "stale-probe.js"), "export {};\n");
    const third = runBuild(tmp, [tmp]);
    assert.equal(third.status, 0, third.stderr + third.stdout);
    assert.equal(existsSync(join(tmp, "dist", "stale-probe.js")), false);
    assert.ok(existsSync(join(tmp, "dist", ".slim-build.json")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("build wipes stale dist outputs after a source module is renamed", { timeout: 120_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "slim-rename-src-"));
  try {
    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(join(tmp, "docs"), { recursive: true });
    writeFileSync(
      join(tmp, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: "dist",
          rootDir: "src",
          declaration: true,
          sourceMap: true,
          noEmitOnError: true,
          skipLibCheck: true,
        },
        include: ["src/**/*.ts"],
      }),
    );
    writeFileSync(join(tmp, "docs", "slim.schema.json"), "{}\n");
    writeFileSync(join(tmp, "src", "keep.ts"), "export const keep = 1;\n");
    const first = runBuild(tmp, [tmp]);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.ok(existsSync(join(tmp, "dist", "keep.js")));
    renameSync(join(tmp, "src", "keep.ts"), join(tmp, "src", "renamed.ts"));
    const second = runBuild(tmp, [tmp]);
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.ok(existsSync(join(tmp, "dist", "renamed.js")));
    assert.ok(existsSync(join(tmp, "dist", "renamed.d.ts")));
    assert.ok(existsSync(join(tmp, "dist", "renamed.js.map")));
    assert.equal(existsSync(join(tmp, "dist", "keep.js")), false);
    assert.equal(existsSync(join(tmp, "dist", "keep.d.ts")), false);
    assert.equal(existsSync(join(tmp, "dist", "keep.js.map")), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("build removes obsolete catalog TypeScript copies", { timeout: 120_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "slim-catalog-orphan-"));
  try {
    mkdirSync(join(tmp, "src", "generate", "catalog"), { recursive: true });
    mkdirSync(join(tmp, "docs"), { recursive: true });
    writeFileSync(
      join(tmp, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: "dist",
          rootDir: "src",
          declaration: true,
          sourceMap: true,
          noEmitOnError: true,
          skipLibCheck: true,
        },
        include: ["src/**/*.ts"],
      }),
    );
    writeFileSync(join(tmp, "docs", "slim.schema.json"), "{}\n");
    writeFileSync(join(tmp, "src", "keep.ts"), "export const keep = 1;\n");
    writeFileSync(join(tmp, "src", "generate", "catalog", "keep.ts"), "export const catalogKeep = 1;\n");
    writeFileSync(join(tmp, "src", "generate", "catalog", "gone.ts"), "export const catalogGone = 2;\n");
    const first = runBuild(tmp, [tmp]);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.ok(existsSync(join(tmp, "dist", "generate", "catalog", "keep.ts")));
    assert.ok(existsSync(join(tmp, "dist", "generate", "catalog", "gone.ts")));
    assert.ok(existsSync(join(tmp, "dist", "generate", "catalog", "gone.js")));
    rmSync(join(tmp, "src", "generate", "catalog", "gone.ts"));
    writeFileSync(join(tmp, "dist", "generate", "catalog", "stale-probe.ts"), "export {};\n");
    const second = runBuild(tmp, [tmp]);
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.ok(existsSync(join(tmp, "dist", "generate", "catalog", "keep.ts")));
    assert.equal(existsSync(join(tmp, "dist", "generate", "catalog", "gone.ts")), false);
    assert.equal(existsSync(join(tmp, "dist", "generate", "catalog", "gone.js")), false);
    assert.equal(existsSync(join(tmp, "dist", "generate", "catalog", "gone.d.ts")), false);
    assert.equal(existsSync(join(tmp, "dist", "generate", "catalog", "gone.js.map")), false);
    assert.equal(existsSync(join(tmp, "dist", "generate", "catalog", "stale-probe.ts")), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("two clean builds and an incremental build produce equivalent dist manifests", { timeout: 180_000 }, () => {
  withRepoDistLock(() => {
    rmSync(DIST, { recursive: true, force: true });
    const a = runBuild(ROOT);
    assert.equal(a.status, 0, a.stderr + a.stdout);
    const first = distManifest();
    const stamp1 = stampOf();
    assert.equal(stamp1.ok, true);
    assert.deepEqual(stamp1.files, first.files);
    assert.equal(stamp1.sha256, first.sha256);
    assert.match(stamp1.actionSha256 ?? "", /^[0-9a-f]{64}$/);

    rmSync(DIST, { recursive: true, force: true });
    const b = runBuild(ROOT);
    assert.equal(b.status, 0, b.stderr + b.stdout);
    const second = distManifest();
    const stamp2 = stampOf();
    assert.deepEqual(second, first);
    assert.deepEqual(stamp2.files, stamp1.files);
    assert.equal(stamp2.sha256, stamp1.sha256);
    assert.equal(stamp2.actionSha256, stamp1.actionSha256);

    const c = runBuild(ROOT);
    assert.equal(c.status, 0, c.stderr + c.stdout);
    const third = distManifest();
    const stamp3 = stampOf();
    assert.deepEqual(third, first);
    assert.deepEqual(stamp3.files, stamp1.files);
    assert.equal(stamp3.sha256, stamp1.sha256);
    assert.equal(stamp3.actionSha256, stamp1.actionSha256);
  });
});

test("failed tsc leaves no qualified stamp or main.js", { timeout: 60_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "slim-tsc-fail-"));
  try {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(
      join(tmp, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: "dist",
          rootDir: "src",
          declaration: true,
          noEmitOnError: true,
          skipLibCheck: true,
          strict: true,
        },
        include: ["src/**/*.ts"],
      }),
    );
    writeFileSync(join(tmp, "src", "main.ts"), "export const n: number = \"nope\";\n");
    const r = runBuild(tmp, [tmp]);
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(join(tmp, "dist", ".slim-build.json")), false);
    assert.equal(existsSync(join(tmp, "dist", "main.js")), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("pack-ready assert fails on a partial dist without a stamp", { timeout: 30_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "slim-stamp-"));
  try {
    mkdirSync(join(tmp, "dist"), { recursive: true });
    writeFileSync(join(tmp, "dist", "main.js"), "export {};\n");
    const r = spawnSync(process.execPath, [BUILD, "--assert", tmp], {
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.notEqual(r.status, 0);
    assert.match(`${r.stderr}${r.stdout}`, /stamp|qualified|slim-build/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("npm pack and publish dry-run leave tracked metadata unchanged and create no tarball", { timeout: 180_000 }, () => {
  const pkgPath = join(ROOT, "package.json");
  const lockPath = join(ROOT, "package-lock.json");
  const beforePkg = readFileSync(pkgPath);
  const beforeLock = readFileSync(lockPath);
  const built = runBuild(ROOT);
  assert.equal(built.status, 0, built.stderr);
  assert.ok(existsSync(STAMP));

  const pack = withRepoDistLock(() => npmJson(["pack", "--dry-run", "--json"]));
  assert.equal(pack.status, 0, pack.stderr + pack.stdout);
  const publish = withRepoDistLock(() => npmJson(["publish", "--dry-run", "--json"]));
  const publishOut = `${publish.stdout}\n${publish.stderr}`;
  if (publish.status !== 0) {
    assert.match(publishOut, /cannot publish over the previously published versions/i);
  }

  assert.deepEqual(readFileSync(pkgPath), beforePkg);
  assert.deepEqual(readFileSync(lockPath), beforeLock);
  const notices = `${pack.stdout}\n${pack.stderr}\n${publish.stdout}\n${publish.stderr}`;
  assert.doesNotMatch(notices, /package\.json has been rewritten/i);
  assert.doesNotMatch(notices, /auto-corrected/i);

  const tarballs = readdirSync(ROOT).filter((f) => f.endsWith(".tgz"));
  assert.deepEqual(tarballs, []);
  assert.equal(existsSync(join(ROOT, ".pnpm-store")), false);
  assert.equal(existsSync(join(ROOT, "node_modules", ".pnpm-store")), false);

  const pkg = JSON.parse(beforePkg.toString()) as {
    dependencies: Record<string, string>;
    repository: { url: string };
    bugs: { url: string };
    homepage: string;
    main: string;
  };
  assert.deepEqual(pkg.dependencies, {});
  assert.equal(pkg.repository.url, "git+https://github.com/GSXRcoder159/slim.git");
  assert.equal(pkg.bugs.url, "https://github.com/GSXRcoder159/slim/issues");
  assert.equal(pkg.homepage, "https://github.com/GSXRcoder159/slim#readme");
  assert.equal(pkg.main, "./dist/main.js");

  const packed = parseNpmJson(pack.stdout) as Array<{ files: Array<{ path: string }> }>;
  const files = new Set((packed[0]?.files ?? []).map((f) => f.path.replace(/\\/g, "/")));
  assert.ok(files.has("dist/main.js"));
  assert.ok(files.has("dist/.slim-build.json"));
  for (const f of files) {
    assert.ok(!f.startsWith("test/"), f);
    assert.ok(!f.startsWith("fixtures/"), f);
    assert.ok(!f.startsWith("src/"), f);
    assert.ok(!f.includes(".env"), f);
    assert.ok(!f.includes("traces.jsonl"), f);
  }
});

test("qualification commands can run twice without dirtying tracked files", { timeout: 180_000 }, () => {
  const before = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  for (let i = 0; i < 2; i++) {
    const built = runBuild(ROOT);
    assert.equal(built.status, 0, built.stderr);
    const pack = npmJson(["pack", "--dry-run"]);
    assert.equal(pack.status, 0, pack.stderr);
    const publish = npmJson(["publish", "--dry-run"]);
    if (publish.status !== 0) {
      assert.match(`${publish.stdout}\n${publish.stderr}`, /cannot publish over the previously published versions/i);
    }
  }
  const after = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(after, before);
  assert.equal(readdirSync(ROOT).some((f) => f.endsWith(".tgz")), false);
});

test("hermeticPmEnv drops INIT_CWD and points caches at os.tmpdir", () => {
  const env = hermeticPmEnv({ INIT_CWD: ROOT, CI: "1" });
  assert.equal(env.INIT_CWD, undefined);
  assert.equal(env.CI, undefined);
  const cacheRoot = join(tmpdir(), "slim-pm-cache");
  assert.equal(env.npm_config_cache, join(cacheRoot, "npm"));
  assert.equal(env.npm_config_store_dir, join(cacheRoot, "pnpm"));
  assert.equal(env.YARN_CACHE_FOLDER, join(cacheRoot, "yarn"));
  assert.equal(env.BUN_INSTALL_CACHE_DIR, join(cacheRoot, "bun"));
});

test("pnpm install with INIT_CWD set to this repo does not create a repo-local store", { timeout: 120_000 }, () => {
  const NODE_BIN = dirname(process.execPath);
  const COREPACK =
    process.platform === "win32" ? join(NODE_BIN, "corepack.cmd") : join(NODE_BIN, "corepack");
  const pathEnv = `${NODE_BIN}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;
  spawnSync(COREPACK, ["enable"], {
    encoding: "utf8",
    env: { ...process.env, PATH: pathEnv },
    timeout: 60_000,
    ...cmdShimSpawnOpts(COREPACK),
  });
  spawnSync(COREPACK, ["prepare", "pnpm@9.15.9", "--activate"], {
    encoding: "utf8",
    env: { ...process.env, PATH: pathEnv },
    timeout: 60_000,
    ...cmdShimSpawnOpts(COREPACK),
  });
  const dir = mkdtempSync(join(tmpdir(), "slim-pnpm-store-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "store-probe", private: true, dependencies: { ms: "2.1.3" } }),
    );
    const env = hermeticPmEnv({ INIT_CWD: ROOT, PATH: pathEnv });
    const r = spawnPm("pnpm", ["install"], { cwd: dir, encoding: "utf8", env, timeout: 90_000 });
    assert.equal(r.status, 0, String(r.stderr) + String(r.stdout));
    assert.equal(existsSync(join(ROOT, ".pnpm-store")), false);
    assert.equal(existsSync(join(dir, ".pnpm-store")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
