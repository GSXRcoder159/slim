import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  detectRunner,
  nodeTestPreloadArgs,
  traceEnv,
} from "../../src/trace/runners.ts";

function tempPkg(json: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "slim-runner-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(json));
  return dir;
}

test("detects vitest from scripts", () => {
  const dir = tempPkg({
    scripts: { test: "vitest run" },
    devDependencies: { vitest: "^3.0.0" },
  });
  const r = detectRunner(dir);
  assert.equal(r.kind, "vitest");
  assert.equal(r.command, "vitest run");
});

test("detects vitest from devDependencies when no matching script", () => {
  const dir = tempPkg({
    scripts: { build: "tsc" },
    devDependencies: { vitest: "^3.0.0" },
  });
  const r = detectRunner(dir);
  assert.equal(r.kind, "vitest");
  assert.equal(r.command, "npx vitest run");
});

test("detects node:test from --test script", () => {
  const dir = tempPkg({
    scripts: { test: "node --test test/**/*.test.js" },
  });
  const r = detectRunner(dir);
  assert.equal(r.kind, "node:test");
  assert.match(r.command ?? "", /--test/);
});

test("detects jest and returns a v1 snippet, no wrap command", () => {
  const dir = tempPkg({
    scripts: { test: "jest" },
    devDependencies: { jest: "^29.0.0" },
  });
  const r = detectRunner(dir);
  assert.equal(r.kind, "jest");
  assert.equal(r.command, null);
  assert.equal(typeof r.jestSnippet, "string");
  assert.match(r.jestSnippet!, /moduleNameMapper/);
  assert.match(r.jestSnippet!, /does not wrap Jest/i);
});

test("returns none when no runner is present", () => {
  const dir = tempPkg({ name: "empty", scripts: { build: "echo hi" } });
  const r = detectRunner(dir);
  assert.equal(r.kind, "none");
  assert.equal(r.command, null);
});

test("traceEnv sets SLIM_TRACE_*", () => {
  const env = traceEnv(["lodash", "lodash-es"], ".slim/lodash/traces.jsonl");
  assert.equal(env.SLIM_TRACE_PACKAGES, "lodash,lodash-es");
  assert.equal(env.SLIM_TRACE_OUT, ".slim/lodash/traces.jsonl");
});

test("nodeTestPreloadArgs uses --import and a file URL", () => {
  const args = nodeTestPreloadArgs("/abs/hook.js");
  assert.equal(args[0], "--import");
  assert.equal(args[1], pathToFileURL("/abs/hook.js").href);
});
