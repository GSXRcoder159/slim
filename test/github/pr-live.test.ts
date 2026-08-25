import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pr from "../../src/github/pr.ts";

const live = process.env.SLIM_PR_LIVE === "1";
const TMP = join(dirname(fileURLToPath(import.meta.url)), "../../.tmp");

const BODY = `# EVIDENCE, NOT PROOF

## 2. What was used

- Package: \`ms@2.1.3\` (family \`ms\`)
- Symbols: \`ms\`
- Unknowns: 0
- Envelope hash: \`deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef\`

## 3. Byte delta

1000 B estimated original min → 100 B replacement

## 5. Fuzz

- cases: 1
- comparisons: 1
- disagreements: 0
- seed: 1

## 6. Coverage holes

- (none recorded)

## 7. Upstream pin

Slim will watch this slice via \`slim upstream\` / osv.dev.

## 8. How to revert

1. Restore \`ms@2.1.3\` in package.json.

## Residual risk

- Differential fuzzing is evidence, not proof.
`;

if (live) {
  test("live disposable repo PR contains only Slim files and is cleaned up", async () => {
    mkdirSync(TMP, { recursive: true });
    const stamp = Date.now().toString(36);
    const name = `slim-pr-live-${stamp}`;
    const root = mkdtempSync(join(TMP, "slim-pr-live-"));
    execFileSync("git", ["init", "--template=", "-b", "main"], { cwd: root, encoding: "utf8" });
    execFileSync("git", ["config", "user.email", "slim@test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "slim"], { cwd: root });
    writeFileSync(join(root, "README.md"), "live\n");
    writeFileSync(join(root, "unrelated.txt"), "do-not-commit\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root });
    mkdirSync(join(root, "src", "slim"), { recursive: true });
    mkdirSync(join(root, ".slim", "ms"), { recursive: true });
    writeFileSync(join(root, "src", "slim", "ms.ts"), "export function ms() { return 1; }\n");
    writeFileSync(join(root, ".slim", "ms", "evidence.md"), BODY);

    execFileSync("gh", ["repo", "create", name, "--private", "--source", root, "--remote", "origin", "--push"], {
      cwd: root,
      encoding: "utf8",
    });
    try {
      const result = await pr.createPullRequest({
        root,
        title: "slim: replace ms with a verified slice",
        body: BODY,
        branch: "slim/ms",
        files: ["src/slim/ms.ts", ".slim/ms/evidence.md"],
      });
      assert.ok(result.url && result.url.startsWith("https://"), result.url);
      const files = execFileSync("gh", ["pr", "diff", "1", "--name-only"], {
        cwd: root,
        encoding: "utf8",
      });
      assert.match(files, /src\/slim\/ms\.ts/);
      assert.match(files, /\.slim\/ms\/evidence\.md/);
      assert.equal(files.includes("unrelated.txt"), false);
      execFileSync("gh", ["pr", "close", "1", "--delete-branch"], { cwd: root });
    } finally {
      try {
        execFileSync("gh", ["repo", "delete", name, "--yes"], { encoding: "utf8" });
      } catch {
        /* best-effort cleanup */
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
}
