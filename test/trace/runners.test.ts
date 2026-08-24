import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  detectRunner,
  nodeTestPreloadArgs,
  traceEnv,
  writeVitestTraceConfig,
  vitestTraceConfigSource,
  buildTraceSpawn,
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
  assert.match(r.jestSnippet!, /does not wrap Jest/i);
  assert.match(r.jestSnippet!, /--no-trace/);
  assert.doesNotMatch(r.jestSnippet!, /setupFiles/);
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

test("nodeTestPreloadArgs strips types when the hook is TypeScript", () => {
  const args = nodeTestPreloadArgs("/abs/hook.ts");
  assert.equal(args[0], "--experimental-strip-types");
  assert.equal(args[1], "--import");
});

test("vitestTraceConfigSource default-exports slimVitest plugin wrap", () => {
  const src = vitestTraceConfigSource(["lodash", "lodash-es"], "slim/vitest");
  assert.match(src, /export default/);
  assert.match(src, /slimVitest/);
  assert.match(src, /plugins:\s*\[\s*slimVitest\(\{\s*packages:/);
  assert.match(src, /lodash/);
  assert.match(src, /from ["']slim\/vitest["']/);
});

test("writeVitestTraceConfig writes .slim/vitest.trace.ts", () => {
  const dir = tempPkg({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^3" } });
  const path = writeVitestTraceConfig(dir, ["lodash"]);
  assert.equal(path, join(dir, ".slim", "vitest.trace.ts"));
  assert.equal(existsSync(path), true);
  const src = readFileSync(path, "utf8");
  assert.match(src, /export default/);
  assert.match(src, /slimVitest\(\{\s*packages:/);
  assert.match(src, /lodash/);
  assert.match(src, /from ["']file:/);
  assert.doesNotMatch(src, /from ["']slim\/vitest["']/);
});

test("vitestTraceConfigSource merges user config via mergeConfig", () => {
  const src = vitestTraceConfigSource(["lodash"], "slim/vitest", {
    userConfigSpecifier: "../vitest.config.ts",
    alreadyHasPlugin: false,
  });
  assert.match(src, /mergeConfig/);
  assert.match(src, /from ["']vitest\/config["']/);
  assert.match(src, /vitest\.config/);
  assert.match(src, /slimVitest\(\{\s*packages:/);
});

test("vitestTraceConfigSource wraps user config with defineConfig callback merge", () => {
  const src = vitestTraceConfigSource(["lodash"], "slim/vitest", {
    userConfigSpecifier: "../vitest.config.ts",
    alreadyHasPlugin: false,
  });
  assert.match(src, /typeof userConfig === ["']function["']/);
  assert.match(src, /defineConfig/);
  assert.match(src, /import \{ defineConfig, mergeConfig \} from ["']vitest\/config["']/);
  assert.match(src, /export default defineConfig\(async \(env\) =>/);
});

test("writeVitestTraceConfig merges defineConfig(({ mode }) => …) user configs", () => {
  const dir = tempPkg({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^3" } });
  writeFileSync(
    join(dir, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";\nexport default defineConfig(({ mode }) => ({ test: { globals: true } }));\n`,
  );
  const src = readFileSync(writeVitestTraceConfig(dir, ["lodash"]), "utf8");
  assert.match(src, /typeof userConfig === ["']function["']/);
  assert.match(src, /userConfig\(env\)/);
  assert.match(src, /defineConfig\(async \(env\) =>/);
  assert.match(src, /mergeConfig/);
  assert.match(src, /vitest\.config/);
});

test("vitestTraceConfigSource does not duplicate slim/vitest plugin", () => {
  const src = vitestTraceConfigSource(["lodash"], "slim/vitest", {
    userConfigSpecifier: "../vitest.config.ts",
    alreadyHasPlugin: true,
  });
  assert.match(src, /vitest\.config/);
  assert.equal((src.match(/slimVitest\(/g) ?? []).length, 0);
});

test("writeVitestTraceConfig merges existing vitest.config.ts", () => {
  const dir = tempPkg({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^3" } });
  writeFileSync(join(dir, "vitest.config.ts"), "export default { test: { globals: true } };\n");
  const src = readFileSync(writeVitestTraceConfig(dir, ["lodash"]), "utf8");
  assert.match(src, /mergeConfig/);
  assert.match(src, /vitest\.config/);
  assert.match(src, /slimVitest\(\{\s*packages:/);
});

test("writeVitestTraceConfig does not duplicate if user already has slimVitest", () => {
  const dir = tempPkg({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^3" } });
  writeFileSync(
    join(dir, "vitest.config.ts"),
    `import { slimVitest } from "slim/vitest";\nexport default { plugins: [slimVitest()] };\n`,
  );
  const src = readFileSync(writeVitestTraceConfig(dir, ["lodash"]), "utf8");
  assert.match(src, /vitest\.config/);
  assert.equal((src.match(/slimVitest\(/g) ?? []).length, 0);
});

test("buildTraceSpawn passes --config to vitest", () => {
  const spawn = buildTraceSpawn(
    { kind: "vitest", command: "vitest run" },
    { hookPath: "/abs/hook.ts", vitestConfigPath: "/proj/.slim/vitest.trace.ts" },
  );
  assert.ok(spawn);
  assert.equal(spawn.file, "vitest");
  assert.deepEqual(spawn.args, ["run", "--config", "/proj/.slim/vitest.trace.ts"]);
});

test("buildTraceSpawn preloads node:test hook, not a vitest config", () => {
  const spawn = buildTraceSpawn(
    { kind: "node:test", command: "node --test" },
    { hookPath: "/abs/hook.ts" },
  );
  assert.ok(spawn);
  assert.equal(spawn.file, "node");
  assert.equal(spawn.args[0], "--experimental-strip-types");
  assert.equal(spawn.args[1], "--import");
  assert.equal(spawn.args.at(-1), "--test");
});
