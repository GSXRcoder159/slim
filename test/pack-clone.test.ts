import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hermeticPmEnv, spawnPm } from "../src/rewrite/lockfile.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function gitFiles(args: string[]): string[] {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .map((s) => s.trim())
    .filter(Boolean);
}

function snapshotCandidate(dest: string): void {
  execFileSync("git", ["clone", "--local", "--", ROOT, dest], { encoding: "utf8" });
  const tracked = gitFiles(["ls-files", "-z"]);
  const extra = gitFiles(["ls-files", "-z", "--others", "--exclude-standard"]);
  for (const rel of [...tracked, ...extra]) {
    const src = join(ROOT, rel);
    if (!existsSync(src) || statSync(src).isDirectory()) continue;
    const out = join(dest, rel);
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(src, out);
  }
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: dest, encoding: "utf8" });
  if (!dirty.trim()) return;
  execFileSync("git", ["add", "-A"], { cwd: dest });
  execFileSync(
    "git",
    ["-c", "user.email=phase1@test", "-c", "user.name=phase1", "commit", "-m", "candidate snapshot"],
    { cwd: dest, encoding: "utf8" },
  );
}

function npm(
  args: string[],
  cwd: string,
): { status: number; stdout: string; stderr: string } {
  const r = spawnPm("npm", args, {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
    env: hermeticPmEnv({ npm_config_update_notifier: "false" }),
  });
  return { status: r.status ?? 1, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
}

test("npm ci, build, typecheck, prepack, and pack/publish dry-run leave a clean clone clean", { timeout: 300_000 }, () => {
  const dest = mkdtempSync(join(tmpdir(), "slim-pack-clone-"));
  const packDest = mkdtempSync(join(tmpdir(), "slim-pack-clone-tgz-"));
  try {
    snapshotCandidate(dest);
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: dest, encoding: "utf8" });
    assert.equal(before, "");

    const ci = npm(["ci"], dest);
    assert.equal(ci.status, 0, ci.stderr + ci.stdout);
    const built = npm(["run", "build"], dest);
    assert.equal(built.status, 0, built.stderr + built.stdout);
    const typed = npm(["run", "typecheck"], dest);
    assert.equal(typed.status, 0, typed.stderr + typed.stdout);
    const prepack = npm(["run", "prepack"], dest);
    assert.equal(prepack.status, 0, prepack.stderr + prepack.stdout);
    const pack = npm(["pack", "--dry-run", `--pack-destination=${packDest}`], dest);
    assert.equal(pack.status, 0, pack.stderr + pack.stdout);
    const publish = npm(["publish", "--dry-run"], dest);
    if (publish.status !== 0) {
      assert.match(
        `${publish.stdout}\n${publish.stderr}`,
        /cannot publish over the previously published versions/i,
      );
    }

    const after = execFileSync("git", ["status", "--porcelain"], { cwd: dest, encoding: "utf8" });
    assert.equal(after, before);
    assert.equal(readdirSync(dest).some((f) => f.endsWith(".tgz")), false);
    assert.equal(existsSync(join(dest, ".pnpm-store")), false);
    assert.equal(existsSync(join(dest, "node_modules", ".pnpm-store")), false);
    assert.equal(existsSync(join(dest, ".slim", "traces.jsonl")), false);
    const pkg = JSON.parse(readFileSync(join(dest, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    assert.deepEqual(pkg.dependencies, {});
    assert.ok(pkg.scripts.typecheck);
    assert.ok(pkg.scripts.artifacts);
  } finally {
    rmSync(dest, { recursive: true, force: true });
    rmSync(packDest, { recursive: true, force: true });
  }
});
