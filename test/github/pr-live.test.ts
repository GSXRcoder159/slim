import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmContentDigest } from "../../src/release/digest.ts";
import { canonicalInventory } from "../../src/support/inventory.ts";
import { githubReceipt, writeReceipt } from "../../src/support/receipts.ts";
import { installFixture, packSlim, ROOT, runSlim } from "../helpers/llm-replace.ts";

const LIVE = process.env.SLIM_PR_LIVE === "1";
const FIXTURE = "ms";

let packDir = "";
let tarball = "";
let npmDigest: string | null = null;

before(() => {
  if (!LIVE) return;
  const packed = packSlim();
  packDir = packed.packDir;
  tarball = packed.tarball;
  npmDigest = npmContentDigest(tarball);
});

after(() => {
  if (packDir) rmSync(packDir, { recursive: true, force: true });
});

function hasGh(): boolean {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;
}

function gh(args: string[], cwd?: string): string {
  return execFileSync("gh", args, { cwd, encoding: "utf8" }).trim();
}

function currentGhUser(): string {
  return JSON.parse(gh(["api", "user"])).login as string;
}

function deleteOrTransferRepo(name: string, owner: string): string {
  try {
    gh(["repo", "delete", `${owner}/${name}`, "--yes"]);
    return "closed+deleted";
  } catch (err) {
    const dest = process.env.SLIM_PR_TRANSFER_OWNER;
    if (!dest) {
      throw new Error(
        `leftover disposable repository ${owner}/${name} (gh repo delete failed: ${err instanceof Error ? err.message : String(err)}). Set SLIM_PR_TRANSFER_OWNER or grant delete_repo.`,
      );
    }
    const res = execFileSync(
      "gh",
      ["api", "-X", "POST", `repos/${owner}/${name}/transfer`, "-f", `new_owner=${dest}`],
      { encoding: "utf8" },
    );
    if (!res) {
      throw new Error(`leftover disposable repository ${owner}/${name}: transfer to ${dest} failed`);
    }
    return `closed+transferred:${dest}`;
  }
}

function writeMsFixture(dest: string, name: string): void {
  mkdirSync(join(dest, "src"), { recursive: true });
  writeFileSync(
    join(dest, "package.json"),
    JSON.stringify({
      name,
      private: true,
      type: "module",
      scripts: { test: "node --experimental-strip-types --test src/index.test.ts" },
      dependencies: { ms: "2.1.3" },
      devDependencies: { typescript: "^5.9.2" },
    }) + "\n",
  );
  writeFileSync(
    join(dest, "src", "index.ts"),
    `import ms from "ms";\nexport function hourMs(): number { return ms("1h") as number; }\n`,
  );
  writeFileSync(
    join(dest, "src", "index.test.ts"),
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { hourMs } from "./index.ts";\ntest("hour", () => assert.equal(hourMs(), 3600000));\n`,
  );
  writeFileSync(join(dest, ".gitignore"), "node_modules\n");
}

test("support inventory advertises github as a required live external service", () => {
  const github = canonicalInventory().entries.find((e) => e.id === "externalService.github");
  assert.ok(github);
  assert.equal(github.kind, "externalService");
  assert.equal(github.name, "github");
  assert.equal(github.receiptClass, "live");
  assert.equal(github.checkId, "test/github/pr-live.test.ts");
});

test("live packed replace opens a scoped GitHub PR and cleans up", { timeout: 300_000 }, async () => {
  if (!LIVE) {
    assert.equal(process.env.SLIM_PR_LIVE ?? "", "", "live tests stay registered when SLIM_PR_LIVE is unset");
    return;
  }
  assert.ok(hasGh() || gitToken(), "gh or GITHUB_TOKEN is required when SLIM_PR_LIVE=1");
  assert.ok(hasGh(), "gh is required to create and delete the disposable live repository");

  const stamp = Date.now().toString(36);
  const name = `slim-pr-live-${stamp}`;
  const dest = mkdtempSync(join(tmpdir(), "slim-pr-packed-"));
  let owner = "";
  let leftover: string | null = null;
  const startedAt = new Date();
  try {
    writeMsFixture(dest, name);
    const slimJs = installFixture(dest, tarball);
    execFileSync("git", ["init", "--template=", "-b", "main"], { cwd: dest, encoding: "utf8" });
    execFileSync("git", ["config", "user.email", "slim@test"], { cwd: dest });
    execFileSync("git", ["config", "user.name", "slim"], { cwd: dest });
    execFileSync("git", ["add", "package.json", "src", ".gitignore"], { cwd: dest });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dest });
    gh(["repo", "create", name, "--private", "--source", dest, "--remote", "origin", "--push"], dest);
    leftover = name;
    owner = currentGhUser();

    const digest = process.env.SLIM_NPM_DIGEST ?? npmDigest;
    const extra: NodeJS.ProcessEnv = { CI: "1" };
    if (digest) extra.SLIM_NPM_DIGEST = digest;
    const out = await runSlim(
      slimJs,
      ["replace", "ms", "--seed", "1", "--budget-ms", "800", "--workers", "1"],
      dest,
      extra,
      180_000,
    );
    assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);

    const slimSha = execFileSync("git", ["rev-parse", "slim/ms"], { cwd: dest, encoding: "utf8" }).trim();
    const remoteHeads = execFileSync("git", ["ls-remote", "--heads", "origin", "refs/heads/slim/ms"], {
      cwd: dest,
      encoding: "utf8",
    }).trim();
    assert.match(remoteHeads, new RegExp(`^${slimSha}\\s+`));

    const independent = JSON.parse(
      gh(["api", `repos/${owner}/${name}/pulls/1`], dest),
    ) as {
      html_url: string;
      title: string;
      body: string;
      base: { ref: string };
      head: { ref: string; sha: string };
    };
    assert.match(independent.title, /ms/);
    assert.equal(independent.head.ref, "slim/ms");
    assert.equal(independent.head.sha, slimSha);
    assert.equal(independent.base.ref, "main");
    assert.match(independent.body, /Candidate artifact digest:\s+`[0-9a-f]{64}`/i);
    if (digest) {
      assert.match(independent.body, new RegExp(`Candidate artifact digest:\\s+\`${digest}\``, "i"));
    }

    const view = JSON.parse(
      gh(["pr", "view", "1", "--json", "title,baseRefName,headRefName,labels,files,url,body"], dest),
    ) as {
      title: string;
      baseRefName: string;
      headRefName: string;
      labels: { name: string }[];
      files: { path: string }[];
      url: string;
      body: string;
    };
    assert.equal(view.url, independent.html_url);
    assert.match(view.title, /ms/);
    assert.equal(view.headRefName, "slim/ms");
    const labelNames = view.labels.map((l) => l.name).sort();
    assert.ok(labelNames.includes("slim"));
    assert.ok(labelNames.includes("slim:replace"));
    const files = view.files.map((f) => f.path);
    assert.ok(files.some((f) => f.includes("src/slim/ms")));
    assert.ok(files.some((f) => f.includes(".slim/ms/evidence.md")));
    assert.equal(files.includes("unrelated.txt"), false);
    for (const f of files) {
      const slimOnly =
        f.startsWith("src/slim/") ||
        f.startsWith(".slim/") ||
        f === "package.json" ||
        f === "slim.json" ||
        /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(f) ||
        f.startsWith("src/");
      assert.equal(slimOnly, true, `unexpected PR file ${f}`);
    }
    const evidence = readFileSync(join(dest, ".slim", "ms", "evidence.md"), "utf8");
    const envHash = evidence.match(/Envelope hash:\s+`([0-9a-f]+)`/i)?.[1];
    const evidenceHash = evidence.match(/Evidence hash:\s+`([0-9a-f]+)`/i)?.[1];
    const moduleDigest = evidence.match(/Module digest:\s+`([0-9a-f]+)`/i)?.[1];
    assert.ok(envHash && evidenceHash && moduleDigest);
    assert.match(view.body, new RegExp(`Envelope hash:\\s+\`${envHash}\``, "i"));
    assert.match(view.body, new RegExp(`Evidence hash:\\s+\`${evidenceHash}\``, "i"));
    assert.match(view.body, new RegExp(`Module digest:\\s+\`${moduleDigest}\``, "i"));
    assert.match(view.body, /Package:\s+`ms@/);
    assert.doesNotMatch(view.body, /ghp_|github_pat|ANTHROPIC_API_KEY|OPENAI_API_KEY/);

    gh(["pr", "close", "1", "--delete-branch"], dest);
    const cleanup = deleteOrTransferRepo(name, owner);
    leftover = null;

    const receiptsDir = process.env.SLIM_RECEIPTS_DIR;
    if (receiptsDir) {
      const commit =
        process.env.SLIM_CANDIDATE_COMMIT ??
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
      writeReceipt(
        receiptsDir,
        "externalService.github",
        githubReceipt({
          fixture: FIXTURE,
          commit,
          npmDigest: digest,
          startedAt,
          endedAt: new Date(),
          log: `${view.url}:${view.headRefName}:${slimSha}:${cleanup}:${out.status}`,
          workflowRun: process.env.SLIM_WORKFLOW_RUN ?? null,
          prUrl: view.url,
          cleanup,
        }),
      );
    }
  } finally {
    if (leftover && owner) {
      try {
        deleteOrTransferRepo(leftover, owner);
        leftover = null;
      } catch (err) {
        process.stderr.write(String(err) + "\n");
      }
    }
    rmSync(dest, { recursive: true, force: true });
  }
  assert.equal(leftover, null, leftover ? `leftover disposable repository ${owner}/${leftover}` : "");
});
