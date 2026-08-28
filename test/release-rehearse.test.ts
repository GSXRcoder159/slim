import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cpSync } from "node:fs";
import { ACTION_WRAPPERS, actionManifest } from "../action/digest.mjs";
import { attachCompiledTree, rollbackAttach } from "../src/release/attach.ts";
import { npmContentDigest } from "../src/release/digest.ts";
import { assertIdentity, npmPublishTarball, runReleaseGate } from "../src/release/gate.ts";
import { hermeticPmEnv } from "../src/rewrite/lockfile.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, ".tmp");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeActionPack(dir: string): void {
  for (const f of ACTION_WRAPPERS) {
    const dest = join(dir, f);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(ROOT, f), dest);
  }
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist/main.js"), "export const n = 1;\n");
  writeFileSync(join(dir, "package.json"), '{"name":"slim","version":"0.1.0"}\n');
  const sha = actionManifest(dir).sha256;
  writeFileSync(
    join(dir, "dist/.slim-build.json"),
    `${JSON.stringify({ ok: true, files: ["main.js"], sha256: "a".repeat(64), actionSha256: sha }, null, 2)}\n`,
  );
}

function tarCreate(work: string, tarball: string): void {
  execFileSync("tar", ["-czf", tarball, "-C", work, "package"], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
}

test("clone rehearsal: identity, packed dry-run, attach rollback, no tag or tarball debris", () => {
  mkdirSync(TMP, { recursive: true });
  const before = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  const dest = mkdtempSync(join(TMP, "slim-rel-clone-"));
  try {
    execFileSync("git", ["clone", "--template=", ROOT, dest], { encoding: "utf8" });
    git(dest, ["config", "user.email", "slim@test"]);
    git(dest, ["config", "user.name", "slim"]);
    assert.equal(readdirSync(dest).some((f) => f.endsWith(".tgz")), false);
    assert.equal(existsSync(join(dest, ".pnpm-store")), false);

    const fixture = mkdtempSync(join(TMP, "slim-rel-rehearse-"));
    git(fixture, ["init", "--template=", "-b", "main"]);
    git(fixture, ["config", "user.email", "slim@test"]);
    git(fixture, ["config", "user.name", "slim"]);
    writeFileSync(
      join(fixture, "package.json"),
      JSON.stringify({
        name: "slim",
        version: "0.1.0",
        repository: { type: "git", url: "git+https://github.com/slim-hq/slim.git" },
      }) + "\n",
    );
    writeFileSync(join(fixture, "CHANGELOG.md"), "# Changelog\n\n## 0.1.0\n");
    mkdirSync(join(fixture, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(fixture, ".github", "workflows", "release.yml"),
      readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8"),
    );
    git(fixture, ["add", "package.json", "CHANGELOG.md", ".github"]);
    git(fixture, ["commit", "-m", "init"]);
    git(fixture, ["tag", "v0.1.0"]);
    assertIdentity(fixture, "v0.1.0", "https://registry.npmjs.org");

    const packWork = mkdtempSync(join(TMP, "slim-rel-rehearse-pack-"));
    const packRoot = join(packWork, "package");
    writeActionPack(packRoot);
    const tarball = join(packWork, "slim-0.1.0.tgz");
    tarCreate(packWork, tarball);
    const digestBefore = npmContentDigest(tarball);

    npmPublishTarball(tarball, { dryRun: true, provenance: false, cwd: fixture, env: hermeticPmEnv() });
    assert.equal(npmContentDigest(tarball), digestBefore);

    const parent = git(fixture, ["rev-parse", "HEAD"]);
    const attached = attachCompiledTree({
      gitRoot: fixture,
      packRoot,
      parentSha: parent,
      versionTag: "v0.1.0",
      floatingTag: "v1",
      push: false,
    });
    rollbackAttach(attached, fixture);
    assert.equal(git(fixture, ["rev-parse", "refs/tags/v0.1.0"]), parent);
    assert.throws(() => git(fixture, ["rev-parse", "--verify", "refs/tags/v1"]));

    rmSync(tarball, { force: true });
    assert.equal(existsSync(tarball), false);
    assert.equal(readdirSync(fixture).some((f) => f.endsWith(".tgz")), false);
    assert.equal(existsSync(join(ROOT, ".pnpm-store")), false);
    assert.equal(readdirSync(ROOT).some((f) => f.endsWith(".tgz")), false);

    const identity = runReleaseGate({
      root: fixture,
      mode: "identity",
      tag: "v0.1.0",
      registryUrl: "https://registry.npmjs.org",
    });
    assert.equal(identity.tag, "v0.1.0");
    rmSync(packWork, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
  const after = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(after, before);
});
