import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = join(ROOT, "test/fixtures/trace/worker");
const HOOK = join(ROOT, "src/trace/hook.ts");

test("worker_threads require of a tiny package is captured under --import", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-trace-worker-"));
  const pkgDir = join(dir, "node_modules", "tiny-trace-worker");
  mkdirSync(pkgDir, { recursive: true });
  cpSync(FIXTURE, pkgDir, { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "app", type: "commonjs" }),
  );
  writeFileSync(
    join(dir, "src", "worker.cjs"),
    `const { parentPort } = require("node:worker_threads");
const { add } = require("tiny-trace-worker");
parentPort.postMessage(add(2, 3));
`,
  );
  const hookUrl = pathToFileURL(HOOK).href;
  writeFileSync(
    join(dir, "src", "index.test.js"),
    `const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Worker } = require("node:worker_threads");
const { join } = require("node:path");
test("worker add", async () => {
  const w = new Worker(join(__dirname, "worker.cjs"), {
    execArgv: ["--experimental-strip-types", "--import", ${JSON.stringify(hookUrl)}],
    env: process.env,
  });
  const n = await new Promise((resolve, reject) => {
    w.once("message", resolve);
    w.once("error", reject);
  });
  assert.equal(n, 5);
  await w.terminate();
});
`,
  );
  const outPath = join(dir, "traces.jsonl");
  const env = { ...process.env, SLIM_TRACE_PACKAGES: "tiny-trace-worker", SLIM_TRACE_OUT: outPath };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--import", pathToFileURL(HOOK).href, "--test", "src/index.test.js"],
    { cwd: dir, encoding: "utf8", env },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const jsonl = readFileSync(outPath, "utf8");
  assert.match(jsonl, /"t":"session"/);
  assert.match(jsonl, /"symbol":"add"/);
});
