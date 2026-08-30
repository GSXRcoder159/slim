/**
 * Helpers for packed Action checkout extract and consumer fixtures.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { symlinkSync } from "node:fs";
import { hermeticPmEnv } from "../../src/rewrite/lockfile.ts";
import { minimalEnvelope, minimalEvidence, minimalManifest, rebindEvidenceArtifacts } from "./documents.ts";
import { packSlim, ROOT } from "./llm-replace.ts";
import { actionManifest, STAMP_NAME } from "../../action/digest.mjs";

const require = createRequire(import.meta.url);

export function extractPackedAction(tarball: string): { dest: string; root: string; actionDigest: string } {
  const dest = mkdtempSync(join(tmpdir(), "slim-action-extract-"));
  execFileSync("tar", ["-xzf", tarball, "-C", dest]);
  const root = join(dest, "package");
  if (!existsSync(join(root, "action/run.mjs"))) {
    throw new Error("packed action missing action/run.mjs");
  }
  if (existsSync(join(root, "src"))) {
    throw new Error("packed action leaked src/");
  }
  const { sha256 } = actionManifest(root);
  return { dest, root, actionDigest: sha256 };
}

export function copyExampleWorkflows(dest: string): void {
  mkdirSync(join(dest, ".github", "workflows"), { recursive: true });
  for (const name of ["slim-check.yml", "slim-bloat.yml", "slim-watch.yml"] as const) {
    const src = join(ROOT, "docs", "examples", name);
    writeFileSync(join(dest, ".github", "workflows", name), readFileSync(src));
  }
}

export function publishedQualifyWorkflow(opts: {
  actionRepo: string;
  actionTag: string;
  actionDigest: string;
}): string {
  const uses = (name: string) => `${opts.actionRepo}/action/${name}@${opts.actionTag}`;
  const failJob = (id: string, fixture: string, action: string, setup: string) => `
  ${id}:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22.18"
      - name: install ${fixture} at root
        shell: bash
        run: |
          shopt -s dotglob
          find . -mindepth 1 -maxdepth 1 ! -name consumers ! -name .git ! -name .github -exec rm -rf {} +
          cp -R consumers/${fixture}/. .
      ${setup}
      - name: ${id} expected
        id: fail_step
        continue-on-error: true
        uses: ${uses(action)}
        env:
          SLIM_ACTION_DIGEST: \${{ env.SLIM_ACTION_DIGEST }}
      - name: assert ${id} failed
        if: steps.fail_step.outcome != 'failure'
        shell: bash
        run: echo "${id} path did not fail" >&2; exit 1
`;
  return `name: qualify-actions
on:
  push:
  workflow_dispatch:
env:
  SLIM_ACTION_DIGEST: ${opts.actionDigest}
jobs:
  cell:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: ["22.18", "24"]
    runs-on: \${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
      - run: npm ci
      - name: check success
        uses: ${uses("check")}
        env:
          SLIM_ACTION_DIGEST: \${{ env.SLIM_ACTION_DIGEST }}
      - name: bloat success
        uses: ${uses("bloat")}
        env:
          SLIM_ACTION_DIGEST: \${{ env.SLIM_ACTION_DIGEST }}
      - name: upstream success
        uses: ${uses("upstream")}
        env:
          SLIM_ACTION_DIGEST: \${{ env.SLIM_ACTION_DIGEST }}
${failJob("bloat-fail", "bloat-fail", "bloat", "")}${failJob(
    "check-fail",
    "check-fail",
    "check",
    `- run: npm install`,
  )}${failJob("upstream-fail", "upstream-fail", "upstream", "")}`;
}

/** Copy packed action/dist/docs onto dest so `uses: ./action/*` can load schemas next to dist. */
export function copyPackedActionCheckout(actionRoot: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(actionRoot)) {
    if (name === "node_modules") continue;
    cpSync(join(actionRoot, name), join(dest, name), { recursive: true });
  }
}

export function packAndExtractAction(): {
  packDir: string;
  tarball: string;
  extractDest: string;
  actionRoot: string;
  actionDigest: string;
} {
  let last = "";
  for (let i = 0; i < 5; i++) {
    const packed = packSlim();
    const extracted = extractPackedAction(packed.tarball);
    let stampSha = "";
    try {
      const stamp = JSON.parse(readFileSync(join(extracted.root, "dist", STAMP_NAME), "utf8")) as {
        actionSha256?: string;
      };
      stampSha = stamp.actionSha256 ?? "";
    } catch {
      stampSha = "";
    }
    if (stampSha === extracted.actionDigest) {
      return {
        packDir: packed.packDir,
        tarball: packed.tarball,
        extractDest: extracted.dest,
        actionRoot: extracted.root,
        actionDigest: extracted.actionDigest,
      };
    }
    last = `stamp ${stampSha} != ${extracted.actionDigest}`;
    rmSync(packed.packDir, { recursive: true, force: true });
    rmSync(extracted.dest, { recursive: true, force: true });
  }
  throw new Error(`packed Action digest did not stabilize (${last})`);
}

export function runNode(
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): { status: number; stdout: string; stderr: string } {
  const env = hermeticPmEnv({ CI: "1", ...extraEnv });
  if (!Object.hasOwn(extraEnv, "SLIM_ACTION_DIGEST")) delete env.SLIM_ACTION_DIGEST;
  const r = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env,
    timeout: 90_000,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function runPackedCli(
  actionRoot: string,
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): { status: number; stdout: string; stderr: string } {
  return runNode([join(actionRoot, "dist/main.js"), ...args], cwd, extraEnv);
}

export function isWorkflowMissingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /HTTP 404/.test(msg) && /not found/i.test(msg);
}

export function workflowRunIdFromList(listed: string): string | null {
  const rows = JSON.parse(listed || "[]") as Array<{ databaseId?: number }>;
  const id = rows[0]?.databaseId;
  return typeof id === "number" && id > 0 ? String(id) : null;
}

export function runPackedAction(
  actionRoot: string,
  cmd: string,
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): { status: number; stdout: string; stderr: string } {
  const env = cmd === "upstream" ? { SLIM_UPSTREAM_PR: "1", ...extraEnv } : extraEnv;
  return runNode([join(actionRoot, "action/run.mjs"), cmd], cwd, env);
}

function linkTypescript(root: string): void {
  const tsDir = dirname(require.resolve("typescript/package.json"));
  mkdirSync(join(root, "node_modules"), { recursive: true });
  const dest = join(root, "node_modules", "typescript");
  if (!existsSync(dest)) symlinkSync(tsDir, dest);
}

export function writeAllSuccessConsumer(root: string): void {
  mkdirSync(join(root, ".slim"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "action-ok",
      private: true,
      type: "module",
      dependencies: {},
      devDependencies: { typescript: "5.9.2" },
    }),
  );
  writeFileSync(join(root, "slim.json"), JSON.stringify({ replacements: {} }));
  writeFileSync(
    join(root, ".slim", "manifest.json"),
    JSON.stringify({ schemaVersion: 1, replacements: {} }),
  );
  linkTypescript(root);
}

export function writeBloatFailConsumer(root: string): void {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "action-bloat-fail",
      private: true,
      type: "module",
      dependencies: { lodash: "4.17.21" },
    }),
  );
}

export function writeCheckFailConsumer(root: string): void {
  const env = minimalEnvelope("lodash", ["get"]);
  mkdirSync(join(root, "src", "slim"), { recursive: true });
  mkdirSync(join(root, ".slim", "lodash"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "action-check-fail",
      private: true,
      type: "module",
      scripts: { "slim:evidence": "node standing.js" },
      dependencies: { lodash: "4.17.21" },
      devDependencies: { typescript: "5.9.2" },
    }),
  );
  writeFileSync(
    join(root, "slim.json"),
    JSON.stringify({
      outDir: "src/slim",
      testCommand: null,
      replacements: {
        lodash: {
          version: "4.17.21",
          envelope: ".slim/lodash/envelope.json",
          module: "src/slim/lodash.ts",
        },
      },
    }),
  );
  writeFileSync(join(root, ".slim", "lodash", "envelope.json"), JSON.stringify(env));
  writeFileSync(join(root, ".slim", "manifest.json"), JSON.stringify(minimalManifest(env)));
  writeFileSync(join(root, "src", "slim", "lodash.ts"), "export function get() { return 1; }\n");
  writeFileSync(
    join(root, "src", "slim", "lodash.test.ts"),
    `import { test } from "node:test";\ntest("standing", () => {});\n`,
  );
  writeFileSync(
    join(root, "src", "slim", "lodash.hardened.test.ts"),
    `import { test } from "node:test";\ntest("hardened", () => {});\n`,
  );
  writeFileSync(join(root, "standing.js"), "process.exit(0);\n");
  linkTypescript(root);
}

export function writeCheckOkConsumer(root: string): void {
  writeCheckFailConsumer(root);
  const env = minimalEnvelope("lodash", ["get"]);
  writeFileSync(join(root, ".slim", "lodash", "evidence.json"), JSON.stringify(minimalEvidence(env)));
  rebindEvidenceArtifacts(root, "lodash", "src/slim");
}

export function writeUpstreamFailConsumer(root: string): void {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "action-upstream-fail", private: true, type: "module" }),
  );
}

export { packSlim };
