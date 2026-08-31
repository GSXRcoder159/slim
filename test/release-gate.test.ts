import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_ENV, EXIT_FAIL, EXIT_REFUSED, SlimExit } from "../src/exit.ts";
import { ACTION_WRAPPERS, actionManifest } from "../action/digest.mjs";
import { actionDigestFromPack, npmContentDigest } from "../src/release/digest.ts";
import {
  ADVERTISED_ACTION_TAG,
  assertCleanTree,
  assertPackageIdentity,
  assertRegistry,
  assertVersionIdentity,
  assertWorkflowPermissions,
  changelogVersion,
  floatingTag,
  packageVersion,
  versionTag,
} from "../src/release/identity.ts";
import { attachCompiledTree, rollbackAttach } from "../src/release/attach.ts";
import {
  assertIdentity,
  assertTarballMatchesRoot,
  isDryRunVersionConflict,
  npmPublishArgs,
  npmPublishTarball,
  resolveCommit,
  runReleaseGate,
} from "../src/release/gate.ts";
import { assertPublishRef } from "../src/release/identity.ts";
import { writeQualifyBundle, assertQualifyBundle } from "../src/release/bundle.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, ".tmp");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initReleaseFixture(opts?: {
  version?: string;
  changelog?: string;
  name?: string;
  repository?: string;
  bugs?: string;
  homepage?: string;
  publishConfig?: string | null;
  publishAccess?: string | null;
  tag?: string | null;
}): string {
  mkdirSync(TMP, { recursive: true });
  const root = mkdtempSync(join(TMP, "slim-rel-id-"));
  const version = opts?.version ?? "0.1.0";
  git(root, ["init", "--template=", "-b", "main"]);
  git(root, ["config", "user.email", "slim@test"]);
  git(root, ["config", "user.name", "slim"]);
  const pkg: Record<string, unknown> = {
    name: opts?.name ?? "@gsxrcoder159/slim",
    version,
    repository: { type: "git", url: opts?.repository ?? "git+https://github.com/GSXRcoder159/slim.git" },
    bugs: { url: opts?.bugs ?? "https://github.com/GSXRcoder159/slim/issues" },
    homepage: opts?.homepage ?? "https://github.com/GSXRcoder159/slim#readme",
  };
  if (opts?.publishConfig !== null) {
    pkg.publishConfig = {
      registry: opts?.publishConfig ?? "https://registry.npmjs.org",
      ...(opts?.publishAccess !== null ? { access: opts?.publishAccess ?? "public" } : {}),
    };
  }
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  writeFileSync(join(root, "CHANGELOG.md"), opts?.changelog ?? `# Changelog\n\n## ${version}\n\nNotes.\n`);
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(root, ".github", "workflows", "release.yml"),
    `name: release
on:
  push:
    tags: ["v*"]
permissions:
  id-token: write
  contents: write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`,
  );
  git(root, ["add", "package.json", "CHANGELOG.md", ".github"]);
  git(root, ["commit", "-m", "init"]);
  if (opts?.tag !== null) {
    git(root, ["tag", opts?.tag ?? `v${version}`]);
  }
  return root;
}

function writePackTree(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body);
  }
}

function tarCreate(work: string, tarball: string): void {
  execFileSync("tar", ["-czf", tarball, "-C", work, "package"], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
}

function freeOccupancy(): Promise<Response> {
  return Promise.resolve(new Response(null, { status: 404 }));
}

/** Pin publish-mode tests off ambient GITHUB_REF / GITHUB_EVENT_NAME (CI push to a branch). */
function publishTagRef(tag = "v0.1.0"): { eventName: string; gitRef: string } {
  return { eventName: "push", gitRef: `refs/tags/${tag}` };
}

function isSlimExit(err: unknown, code: number, re: RegExp): boolean {
  return err instanceof SlimExit && err.code === code && re.test(err.message);
}

test("versionTag and floatingTag for 0.x advertise v1", () => {
  assert.equal(versionTag("0.1.0"), "v0.1.0");
  assert.equal(floatingTag("0.1.0"), "v1");
  assert.equal(ADVERTISED_ACTION_TAG, "v1");
  assert.equal(floatingTag("1.2.3"), "v1");
  assert.equal(floatingTag("2.0.0"), "v2");
});

test("tag that does not exactly match package.json version is refused", () => {
  const root = initReleaseFixture({ version: "0.1.0" });
  try {
    for (const tag of ["v1", "v0.1", "v0.1.0-beta", "0.1.0", "V0.1.0"]) {
      assert.throws(
        () => assertVersionIdentity({ root, tag }),
        (err: unknown) => isSlimExit(err, EXIT_REFUSED, /tag/i),
        tag,
      );
    }
    assert.equal(packageVersion(root), "0.1.0");
    assert.equal(changelogVersion(root), "0.1.0");
    assertVersionIdentity({ root, tag: "v0.1.0" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changelog heading that does not match package.json version is refused", () => {
  const root = initReleaseFixture({ version: "0.1.0", changelog: "# Changelog\n\n## 0.2.0\n" });
  try {
    assert.equal(changelogVersion(root), "0.2.0");
    assert.throws(
      () => assertVersionIdentity({ root, tag: "v0.1.0" }),
      (err: unknown) => isSlimExit(err, EXIT_REFUSED, /changelog/i),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dirty and untracked trees are refused", () => {
  const root = initReleaseFixture();
  try {
    assertCleanTree(root);
    writeFileSync(join(root, "package.json"), readFileSync(join(root, "package.json"), "utf8") + "\n");
    assert.throws(
      () => assertCleanTree(root),
      (err: unknown) => isSlimExit(err, EXIT_REFUSED, /dirty/i),
    );
    git(root, ["checkout", "--", "package.json"]);
    writeFileSync(join(root, "untracked.txt"), "nope\n");
    assert.throws(
      () => assertCleanTree(root),
      (err: unknown) => isSlimExit(err, EXIT_REFUSED, /dirty|untracked/i),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrong package name or repository identity is refused", () => {
  const other = initReleaseFixture({ name: "other" });
  try {
    assert.throws(
      () => assertPackageIdentity(other),
      (err: unknown) => isSlimExit(err, EXIT_REFUSED, /package|name/i),
    );
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
  const repo = initReleaseFixture({ repository: "git+https://github.com/acme/slim.git" });
  try {
    assert.throws(
      () => assertPackageIdentity(repo),
      (err: unknown) => isSlimExit(err, EXIT_REFUSED, /repository/i),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  const ok = initReleaseFixture();
  try {
    assertPackageIdentity(ok);
  } finally {
    rmSync(ok, { recursive: true, force: true });
  }
  const missingHome = initReleaseFixture({ homepage: "https://example.com" });
  try {
    assert.throws(
      () => assertPackageIdentity(missingHome),
      (err: unknown) => isSlimExit(err, EXIT_REFUSED, /homepage/i),
    );
  } finally {
    rmSync(missingHome, { recursive: true, force: true });
  }
  const missingPub = initReleaseFixture({ publishConfig: null });
  try {
    assert.throws(
      () => assertPackageIdentity(missingPub),
      (err: unknown) => isSlimExit(err, EXIT_REFUSED, /publishConfig/i),
    );
  } finally {
    rmSync(missingPub, { recursive: true, force: true });
  }
  const privatePub = initReleaseFixture({ publishAccess: null });
  try {
    assert.throws(
      () => assertPackageIdentity(privatePub),
      (err: unknown) => isSlimExit(err, EXIT_REFUSED, /access.*public/i),
    );
  } finally {
    rmSync(privatePub, { recursive: true, force: true });
  }
});

test("non-npmjs registry is refused", () => {
  assert.throws(
    () => assertRegistry("https://pkg.example.com"),
    (err: unknown) => isSlimExit(err, EXIT_REFUSED, /registry/i),
  );
  assertRegistry("https://registry.npmjs.org");
  assertRegistry("https://registry.npmjs.org/");
});

test("workflow missing provenance or contents permission is refused", () => {
  const missingId = `name: release
permissions:
  contents: write
jobs: {}
`;
  assert.throws(
    () => assertWorkflowPermissions(missingId),
    (err: unknown) => isSlimExit(err, EXIT_ENV, /id-token/i),
  );
  const missingContents = `name: release
permissions:
  id-token: write
jobs: {}
`;
  assert.throws(
    () => assertWorkflowPermissions(missingContents),
    (err: unknown) => isSlimExit(err, EXIT_ENV, /contents/i),
  );
  assertWorkflowPermissions(`permissions:
  id-token: write
  contents: write
`);
});

test("npm content digest is stable across tar mtimes and independent of wrapper bytes", () => {
  const work = mkdtempSync(join(tmpdir(), "slim-rel-tar-"));
  try {
    writePackTree(join(work, "package"), {
      "package.json": '{"name":"@gsxrcoder159/slim","version":"0.1.0"}\n',
      "dist/main.js": "export const n = 1;\n",
      "README.md": "hi\n",
    });
    const a = join(work, "a.tgz");
    const b = join(work, "b.tgz");
    tarCreate(work, a);
    utimesSync(join(work, "package", "dist/main.js"), new Date("2020-01-01"), new Date("2020-01-01"));
    tarCreate(work, b);
    const digestA = npmContentDigest(a);
    const digestB = npmContentDigest(b);
    assert.match(digestA, /^[0-9a-f]{64}$/);
    assert.equal(digestA, digestB);
    const rawA = createHash("sha256").update(readFileSync(a)).digest("hex");
    const rawB = createHash("sha256").update(readFileSync(b)).digest("hex");
    assert.notEqual(rawA, rawB, "tar wrapper bytes must not be the identity");
    writeFileSync(join(work, "package", "dist/main.js"), "export const n = 2;\n");
    const c = join(work, "c.tgz");
    tarCreate(work, c);
    assert.notEqual(npmContentDigest(c), digestA);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("canonical package identity is the scoped name and this repository matches it", () => {
  assert.equal(packageVersion(ROOT), "0.1.0");
  assert.equal(changelogVersion(ROOT), "0.1.0");
  assert.equal(versionTag(packageVersion(ROOT)), "v0.1.0");
  assertPackageIdentity(ROOT);
});

test("npm publish args always include the tarball path and never a bare publish", () => {
  const tarball = "/tmp/slim-0.1.0.tgz";
  assert.deepEqual(npmPublishArgs(tarball, { dryRun: true, provenance: true }), [
    "publish",
    tarball,
    "--dry-run",
    "--provenance",
  ]);
  assert.deepEqual(npmPublishArgs(tarball, { dryRun: false, provenance: true }), [
    "publish",
    tarball,
    "--provenance",
  ]);
});

test("npm publish dry-run refuses an already-published version as occupied", () => {
  mkdirSync(TMP, { recursive: true });
  const tarball = join(TMP, "slim-dry-conflict.tgz");
  writeFileSync(tarball, "tarball");
  try {
    assert.equal(
      isDryRunVersionConflict("You cannot publish over the previously published versions: 0.1.0."),
      true,
    );
    assert.throws(
      () =>
        npmPublishTarball(
          tarball,
          { dryRun: true, provenance: false, cwd: ROOT },
          () => {
            throw new Error("npm error You cannot publish over the previously published versions: 0.1.0.");
          },
        ),
      (err: unknown) => isSlimExit(err, EXIT_REFUSED, /occupied|already published/i),
    );
  } finally {
    rmSync(tarball, { force: true });
  }
});

test("npm publish without GITHUB_ACTIONS is refused", () => {
  const prev = process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  mkdirSync(TMP, { recursive: true });
  const tarball = join(TMP, "missing-slim.tgz");
  writeFileSync(tarball, "not-a-real-tarball");
  try {
    assert.throws(
      () => npmPublishTarball(tarball, { dryRun: false, provenance: true, cwd: ROOT }),
      (err: unknown) => isSlimExit(err, EXIT_ENV, /outside GitHub Actions/),
    );
  } finally {
    rmSync(tarball, { force: true });
    if (prev === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = prev;
  }
});

function writeActionPack(dir: string): string {
  for (const f of ACTION_WRAPPERS) {
    const dest = join(dir, f);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(ROOT, f), dest);
  }
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist/main.js"), "export const n = 1;\n");
  writeFileSync(join(dir, "package.json"), '{"name":"@gsxrcoder159/slim","version":"0.1.0"}\n');
  const sha = actionManifest(dir).sha256;
  writeFileSync(
    join(dir, "dist/.slim-build.json"),
    `${JSON.stringify({ ok: true, files: ["main.js"], sha256: "a".repeat(64), actionSha256: sha }, null, 2)}\n`,
  );
  return sha;
}

test("packed Action digest matches stamp and current tree; a post-pack rewrite fails closed", () => {
  mkdirSync(TMP, { recursive: true });
  const work = mkdtempSync(join(TMP, "slim-rel-art-"));
  try {
    const packDir = join(work, "package");
    const sha = writeActionPack(packDir);
    const tarball = join(work, "slim.tgz");
    tarCreate(work, tarball);
    const id = assertTarballMatchesRoot(tarball, packDir);
    assert.equal(id.actionDigest, sha);
    assert.equal(id.actionDigest, actionDigestFromPack(packDir));
    assert.equal(actionManifest(packDir).sha256, actionDigestFromPack(packDir));
    assert.match(id.npmDigest, /^[0-9a-f]{64}$/);
    const rewritten = join(work, "rewritten");
    cpSync(packDir, rewritten, { recursive: true });
    writeFileSync(join(rewritten, "dist/main.js"), "export const n = 2;\n");
    assert.throws(
      () => assertTarballMatchesRoot(tarball, rewritten),
      (err: unknown) => isSlimExit(err, EXIT_FAIL, /Action digest mismatch/),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("identity gate passes a clean matching fixture and refuses a dirty one", async () => {
  const root = initReleaseFixture();
  try {
    assertIdentity(root, "v0.1.0", "https://registry.npmjs.org");
    const out = await runReleaseGate({
      root,
      mode: "identity",
      tag: "v0.1.0",
      registryUrl: "https://registry.npmjs.org",
      occupancyFetch: freeOccupancy,
    });
    assert.equal(out.tag, "v0.1.0");
    assert.equal(out.floatingTag, "v1");
    writeFileSync(join(root, "extra.txt"), "nope\n");
    await assert.rejects(
      () =>
        runReleaseGate({
          root,
          mode: "identity",
          tag: "v0.1.0",
          registryUrl: "https://registry.npmjs.org",
          occupancyFetch: freeOccupancy,
        }),
      (err: unknown) => isSlimExit(err, EXIT_REFUSED, /dirty|untracked/i),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attachCompiledTree commit-tree supplies GIT_AUTHOR when unset", () => {
  const root = initReleaseFixture();
  mkdirSync(TMP, { recursive: true });
  const packWork = mkdtempSync(join(TMP, "slim-rel-ident-"));
  const prevAuthor = process.env.GIT_AUTHOR_NAME;
  const prevEmail = process.env.GIT_AUTHOR_EMAIL;
  const prevCName = process.env.GIT_COMMITTER_NAME;
  const prevCEmail = process.env.GIT_COMMITTER_EMAIL;
  delete process.env.GIT_AUTHOR_NAME;
  delete process.env.GIT_AUTHOR_EMAIL;
  delete process.env.GIT_COMMITTER_NAME;
  delete process.env.GIT_COMMITTER_EMAIL;
  try {
    const packRoot = join(packWork, "package");
    writeActionPack(packRoot);
    const parent = git(root, ["rev-parse", "HEAD"]);
    const seen: NodeJS.ProcessEnv[] = [];
    attachCompiledTree(
      {
        gitRoot: root,
        packRoot,
        parentSha: parent,
        versionTag: "v0.1.0",
        floatingTag: "v1",
        push: false,
      },
      (file, args = [], opts) => {
        if (file === "git" && args[0] === "commit-tree") {
          seen.push((opts as { env?: NodeJS.ProcessEnv }).env ?? {});
        }
        return execFileSync(file, [...args], opts);
      },
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.GIT_AUTHOR_NAME, "slim");
    assert.equal(seen[0]!.GIT_AUTHOR_EMAIL, "slim@users.noreply.github.com");
    assert.equal(seen[0]!.GIT_COMMITTER_NAME, "slim");
    assert.equal(seen[0]!.GIT_COMMITTER_EMAIL, "slim@users.noreply.github.com");
  } finally {
    if (prevAuthor === undefined) delete process.env.GIT_AUTHOR_NAME;
    else process.env.GIT_AUTHOR_NAME = prevAuthor;
    if (prevEmail === undefined) delete process.env.GIT_AUTHOR_EMAIL;
    else process.env.GIT_AUTHOR_EMAIL = prevEmail;
    if (prevCName === undefined) delete process.env.GIT_COMMITTER_NAME;
    else process.env.GIT_COMMITTER_NAME = prevCName;
    if (prevCEmail === undefined) delete process.env.GIT_COMMITTER_EMAIL;
    else process.env.GIT_COMMITTER_EMAIL = prevCEmail;
    rmSync(root, { recursive: true, force: true });
    rmSync(packWork, { recursive: true, force: true });
  }
});

test("attachCompiledTree push authenticates GitHub HTTPS from GH_TOKEN", () => {
  const root = initReleaseFixture();
  mkdirSync(TMP, { recursive: true });
  const packWork = mkdtempSync(join(TMP, "slim-rel-push-"));
  const prev = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "ghp_test_token_not_real";
  try {
    const packRoot = join(packWork, "package");
    writeActionPack(packRoot);
    const parent = git(root, ["rev-parse", "HEAD"]);
    const seen: NodeJS.ProcessEnv[] = [];
    attachCompiledTree(
      {
        gitRoot: root,
        packRoot,
        parentSha: parent,
        versionTag: "v0.1.0",
        floatingTag: "v1",
        push: true,
        remote: "origin",
      },
      (file, args = [], opts) => {
        if (file === "git" && args[0] === "push") {
          seen.push((opts as { env?: NodeJS.ProcessEnv }).env ?? {});
          return "";
        }
        return execFileSync(file, [...args], opts);
      },
    );
    assert.ok(seen.length >= 1);
    const env = seen[0]!;
    const count = Number(env.GIT_CONFIG_COUNT ?? "0");
    let header = "";
    for (let i = 0; i < count; i++) {
      if (env[`GIT_CONFIG_KEY_${i}`] === "http.https://github.com/.extraheader") {
        header = String(env[`GIT_CONFIG_VALUE_${i}`] ?? "");
      }
    }
    assert.match(header, /^AUTHORIZATION: basic /);
    const b64 = header.slice("AUTHORIZATION: basic ".length);
    assert.equal(Buffer.from(b64, "base64").toString("utf8"), "x-access-token:ghp_test_token_not_real");
  } finally {
    if (prev === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prev;
    rmSync(root, { recursive: true, force: true });
    rmSync(packWork, { recursive: true, force: true });
  }
});

test("attachCompiledTree moves version and floating tags onto the pack tree and rollback restores them", () => {
  const root = initReleaseFixture();
  mkdirSync(TMP, { recursive: true });
  const packWork = mkdtempSync(join(TMP, "slim-rel-att-"));
  try {
    const packRoot = join(packWork, "package");
    writeActionPack(packRoot);
    writeFileSync(join(packRoot, "dist/main.js"), "export const attached = 1;\n");
    const parent = git(root, ["rev-parse", "HEAD"]);
    const before = git(root, ["rev-parse", "refs/tags/v0.1.0"]);
    assert.equal(before, parent);
    const attached = attachCompiledTree({
      gitRoot: root,
      packRoot,
      parentSha: parent,
      versionTag: "v0.1.0",
      floatingTag: "v1",
      push: false,
    });
    assert.match(attached.commit, /^[0-9a-f]{40}$/);
    assert.equal(git(root, ["rev-parse", "refs/tags/v0.1.0"]), attached.commit);
    assert.equal(git(root, ["rev-parse", "refs/tags/v1"]), attached.commit);
    const files = git(root, ["ls-tree", "-r", "--name-only", attached.commit]);
    assert.match(files, /dist\/main\.js/);
    assert.match(files, /action\/run\.mjs/);
    assert.doesNotMatch(files, /^src\//m);
    rollbackAttach(attached, root);
    assert.equal(git(root, ["rev-parse", "refs/tags/v0.1.0"]), parent);
    assert.throws(() => git(root, ["rev-parse", "--verify", "refs/tags/v1"]));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(packWork, { recursive: true, force: true });
  }
});

test("supplied commit that does not match HEAD is refused", () => {
  const root = initReleaseFixture();
  try {
    assert.throws(
      () => resolveCommit(root, "a".repeat(40), execFileSync),
      (err: unknown) => isSlimExit(err, EXIT_REFUSED, /does not match HEAD/),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GITHUB_SHA does not bind a fixture outside GITHUB_WORKSPACE", () => {
  const root = initReleaseFixture();
  const prevSha = process.env.GITHUB_SHA;
  const prevWs = process.env.GITHUB_WORKSPACE;
  const prevCandidate = process.env.SLIM_CANDIDATE_COMMIT;
  process.env.GITHUB_SHA = "c".repeat(40);
  process.env.SLIM_CANDIDATE_COMMIT = "d".repeat(40);
  process.env.GITHUB_WORKSPACE = ROOT;
  try {
    const head = git(root, ["rev-parse", "HEAD"]);
    assert.equal(resolveCommit(root, undefined, execFileSync), head);
  } finally {
    if (prevSha === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = prevSha;
    if (prevWs === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = prevWs;
    if (prevCandidate === undefined) delete process.env.SLIM_CANDIDATE_COMMIT;
    else process.env.SLIM_CANDIDATE_COMMIT = prevCandidate;
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_dispatch publish from a non-default branch is refused", () => {
  assert.throws(
    () =>
      assertPublishRef({
        mode: "publish",
        tag: "v0.1.0",
        eventName: "workflow_dispatch",
        ref: "refs/heads/gap-closure",
      }),
    (err: unknown) => isSlimExit(err, EXIT_REFUSED, /main/),
  );
  assertPublishRef({
    mode: "publish",
    tag: "v0.1.0",
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
  });
  assertPublishRef({
    mode: "publish",
    tag: "v0.1.0",
    eventName: "push",
    ref: "refs/tags/v0.1.0",
  });
  assertPublishRef({ mode: "rehearse", tag: "v0.1.0", eventName: "workflow_dispatch", ref: "refs/heads/feat" });
});

test("publish without a qualification bundle is refused before attach", async () => {
  const root = initReleaseFixture();
  const prevEvent = process.env.GITHUB_EVENT_NAME;
  const prevRef = process.env.GITHUB_REF;
  process.env.GITHUB_EVENT_NAME = "push";
  process.env.GITHUB_REF = "refs/heads/main";
  try {
    await assert.rejects(
      () =>
        runReleaseGate({
          root,
          mode: "publish",
          tag: "v0.1.0",
          registryUrl: "https://registry.npmjs.org",
          occupancyFetch: freeOccupancy,
          qualificationRun: "1",
          ...publishTagRef(),
        }),
      (err: unknown) => isSlimExit(err, EXIT_REFUSED, /bundle/),
    );
  } finally {
    if (prevEvent === undefined) delete process.env.GITHUB_EVENT_NAME;
    else process.env.GITHUB_EVENT_NAME = prevEvent;
    if (prevRef === undefined) delete process.env.GITHUB_REF;
    else process.env.GITHUB_REF = prevRef;
    rmSync(root, { recursive: true, force: true });
  }
});

test("qualification bundle commit mismatch is refused before attach", async () => {
  const root = initReleaseFixture();
  mkdirSync(TMP, { recursive: true });
  const packWork = mkdtempSync(join(TMP, "slim-rel-bundle-"));
  try {
    const packRoot = join(packWork, "package");
    const sha = writeActionPack(packRoot);
    const tarball = join(packWork, "slim.tgz");
    tarCreate(packWork, tarball);
    const bundleDir = join(packWork, "bundle");
    writeQualifyBundle({
      dir: bundleDir,
      tarball,
      receiptsDir: join(packWork, "empty-receipts"),
      commit: "b".repeat(40),
      npmDigest: "c".repeat(64),
      actionDigest: sha,
      distSha256: "d".repeat(64),
    });
    mkdirSync(join(root, "dist"), { recursive: true });
    await assert.rejects(
      () =>
        runReleaseGate({
          root,
          mode: "publish",
          tag: "v0.1.0",
          bundleDir,
          registryUrl: "https://registry.npmjs.org",
          occupancyFetch: freeOccupancy,
          qualificationRun: "1",
          ...publishTagRef(),
        }),
      (err: unknown) => isSlimExit(err, EXIT_REFUSED, /bundle commit/),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(packWork, { recursive: true, force: true });
  }
});

test("stale qualification bundle is refused", () => {
  mkdirSync(TMP, { recursive: true });
  const packWork = mkdtempSync(join(TMP, "slim-rel-stale-"));
  try {
    const packRoot = join(packWork, "package");
    writeActionPack(packRoot);
    const tarball = join(packWork, "slim.tgz");
    tarCreate(packWork, tarball);
    const bundleDir = join(packWork, "bundle");
    writeQualifyBundle({
      dir: bundleDir,
      tarball,
      receiptsDir: join(packWork, "empty-receipts"),
      commit: "a".repeat(40),
      npmDigest: "c".repeat(64),
      actionDigest: "d".repeat(64),
      distSha256: "e".repeat(64),
      packedAt: "2020-01-01T00:00:00.000Z",
    });
    assert.throws(
      () =>
        assertQualifyBundle({
          dir: bundleDir,
          commit: "a".repeat(40),
          now: new Date("2026-08-30T00:00:00.000Z"),
        }),
      (err: unknown) => isSlimExit(err, EXIT_FAIL, /stale/),
    );
  } finally {
    rmSync(packWork, { recursive: true, force: true });
  }
});

test("identity gate refuses an occupied packument before attach", async () => {
  const root = initReleaseFixture();
  try {
    await assert.rejects(
      () =>
        runReleaseGate({
          root,
          mode: "identity",
          tag: "v0.1.0",
          registryUrl: "https://registry.npmjs.org",
          occupancyFetch: async () =>
            new Response(JSON.stringify({ versions: { "0.1.0": {} } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        }),
      (err: unknown) => isSlimExit(err, EXIT_REFUSED, /occupied|already published/i),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source-only checkout binds Action wrappers without requiring dist", () => {
  mkdirSync(TMP, { recursive: true });
  const work = mkdtempSync(join(TMP, "slim-rel-src-"));
  try {
    const packDir = join(work, "package");
    const sha = writeActionPack(packDir);
    const tarball = join(work, "slim.tgz");
    tarCreate(work, tarball);
    const source = join(work, "source");
    for (const f of ACTION_WRAPPERS) {
      const dest = join(source, f);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(packDir, f), dest);
    }
    const id = assertTarballMatchesRoot(tarball, source);
    assert.equal(id.actionDigest, sha);
    writeFileSync(join(source, ACTION_WRAPPERS[0]!), `${readFileSync(join(source, ACTION_WRAPPERS[0]!))}\n`);
    assert.throws(
      () => assertTarballMatchesRoot(tarball, source),
      (err: unknown) => isSlimExit(err, EXIT_FAIL, /Action wrapper/),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("rollbackAttach with push restores or deletes remote tags", () => {
  const root = initReleaseFixture();
  mkdirSync(TMP, { recursive: true });
  const packWork = mkdtempSync(join(TMP, "slim-rel-rb-"));
  try {
    const packRoot = join(packWork, "package");
    writeActionPack(packRoot);
    const parent = git(root, ["rev-parse", "HEAD"]);
    const attached = attachCompiledTree({
      gitRoot: root,
      packRoot,
      parentSha: parent,
      versionTag: "v0.1.0",
      floatingTag: "v1",
      push: false,
    });
    const pushes: string[][] = [];
    const exec: typeof execFileSync = ((file, args, options) => {
      if (file === "git" && args?.[0] === "push") {
        pushes.push([...args]);
        return "";
      }
      return execFileSync(file, args ?? [], options);
    }) as typeof execFileSync;
    rollbackAttach(attached, root, exec, { push: true, remote: "origin" });
    assert.ok(
      pushes.some((a) => a.includes(`+${parent}:refs/tags/v0.1.0`)),
      String(pushes),
    );
    assert.ok(
      pushes.some((a) => a.includes(":refs/tags/v1")),
      String(pushes),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(packWork, { recursive: true, force: true });
  }
});
