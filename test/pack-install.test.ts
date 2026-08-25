import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function run(
  bin: string,
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, CI: "1" };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  const r = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    env,
    timeout: 90_000,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("npm pack contains dist CLI, catalog sources, schema, actions; excludes tests", { timeout: 120_000 }, () => {
  execFileSync("npm", ["run", "build"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  const pack = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
  const parsed = JSON.parse(pack) as Array<{ files: Array<{ path: string }> }>;
  const files = new Set((parsed[0]?.files ?? []).map((f) => f.path.replace(/\\/g, "/")));

  const required = [
    "dist/main.js",
    "dist/main.d.ts",
    "dist/trace/hook.js",
    "dist/fuzz/worker-thread.js",
    "dist/trace/vitest.js",
    "dist/github/check-action.js",
    "dist/generate/catalog/_internal.ts",
    "dist/generate/catalog/lodash.get.ts",
    "action/run.mjs",
    "action/check/action.yml",
    "slim.schema.json",
    "package.json",
    "README.md",
  ];
  for (const f of required) {
    assert.ok(files.has(f), `packed artifact missing ${f}`);
  }
  for (const f of files) {
    assert.ok(!f.startsWith("test/"), `pack leaked test file ${f}`);
    assert.ok(!f.startsWith("fixtures/"), `pack leaked fixture ${f}`);
    assert.ok(!f.startsWith("src/"), `pack leaked source file ${f}`);
  }
  assert.ok(![...files].some((f) => f.includes(".env")), "pack leaked env file");
});

test("installed tarball CLI matches source for help, doctor, scan --json, inspect, replace --dry-run", { timeout: 180_000 }, () => {
  execFileSync("npm", ["run", "build"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  const packDir = mkdtempSync(join(tmpdir(), "slim-install-pack-"));
  const tgz = execFileSync("npm", ["pack", "--silent", `--pack-destination=${packDir}`], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  }).trim();
  const tarball = join(packDir, tgz.split("\n").pop() ?? tgz);
  const tmp = mkdtempSync(join(tmpdir(), "slim-install-"));
  try {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify(
        {
          name: "slim-install-smoke",
          private: true,
          type: "module",
        },
        null,
        2,
      ),
    );
    execFileSync("npm", ["install", tarball, "--omit=dev"], {
      cwd: tmp,
      encoding: "utf8",
      timeout: 60_000,
    });
    const slimJs = join(tmp, "node_modules", "slim", "dist", "main.js");
    assert.ok(existsSync(slimJs), "installed package missing dist/main.js");
    assert.ok(
      existsSync(join(tmp, "node_modules", "slim", "dist", "trace", "hook.js")),
      "installed package missing compiled hook",
    );
    assert.ok(
      existsSync(join(tmp, "node_modules", "slim", "dist", "generate", "catalog", "lodash.get.ts")),
      "installed package missing catalog TypeScript sources",
    );
    assert.equal(
      existsSync(join(tmp, "node_modules", "slim", "node_modules", "typescript")),
      false,
      "installed slim must not nest typescript as a runtime dependency",
    );

    const proj = join(tmp, "app");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(
      join(proj, "package.json"),
      JSON.stringify({
        name: "app",
        private: true,
        type: "module",
        dependencies: { lodash: "4.17.21" },
        devDependencies: { typescript: "5.9.2" },
      }),
    );
    mkdirSync(join(proj, "node_modules"), { recursive: true });
    const lodashDir = dirname(require.resolve("lodash/package.json"));
    const tsDir = dirname(require.resolve("typescript/package.json"));
    symlinkSync(lodashDir, join(proj, "node_modules", "lodash"));
    symlinkSync(tsDir, join(proj, "node_modules", "typescript"));
    writeFileSync(
      join(proj, "src", "index.ts"),
      `import { get } from "lodash";\nexport const x = get({ a: 1 }, "a");\n`,
    );

    const installedBin = [process.execPath, slimJs];
    const sourceBin = [process.execPath, "--experimental-strip-types", join(ROOT, "src/main.ts")];

    const cases: Array<{ args: string[]; json?: boolean }> = [
      { args: ["--help"] },
      { args: ["doctor"] },
      { args: ["scan", "--json"], json: true },
      { args: ["inspect", "lodash"] },
      { args: ["replace", "lodash", "--dry-run", "--no-trace", "--allow-unknown", "--force", "--no-pr"] },
    ];

    for (const c of cases) {
      const src = run(sourceBin[0]!, sourceBin.slice(1).concat(c.args), proj);
      const inst = run(installedBin[0]!, installedBin.slice(1).concat(c.args), proj);
      assert.equal(
        inst.status,
        src.status,
        `${c.args.join(" ")} exit ${inst.status} !== source ${src.status}\nstderr=${inst.stderr}\n${src.stderr}`,
      );
      if (c.json) {
        const a = JSON.parse(src.stdout);
        const b = JSON.parse(inst.stdout);
        assert.deepEqual(b, a, `${c.args.join(" ")} JSON mismatch`);
        assert.equal(inst.stdout.trim().startsWith("{"), true);
      } else {
        assert.equal(inst.stdout.includes("{") && inst.stdout.trim().startsWith("{"), false);
        if (c.args[0] === "--help" || c.args[0] === "doctor" || c.args[0] === "inspect") {
          assert.equal(inst.stdout, src.stdout, `${c.args.join(" ")} stdout mismatch`);
        }
      }
    }

    const slimRoot = join(tmp, "node_modules", "slim");
    const hookJs = join(slimRoot, "dist", "trace", "hook.js");
    const vitestJs = join(slimRoot, "dist", "trace", "vitest.js");
    const workersJs = join(slimRoot, "dist", "fuzz", "workers.js");
    const hookLoad = run(
      process.execPath,
      ["--import", pathToFileURL(hookJs).href, "-e", "console.log('hook-ok')"],
      proj,
      { SLIM_TRACE_PACKAGES: "lodash" },
    );
    assert.equal(hookLoad.status, 0, hookLoad.stderr);
    assert.match(hookLoad.stdout, /hook-ok/);

    const captureDir = join(tmp, "trace-app");
    mkdirSync(join(captureDir, "node_modules", "tiny-trace-cjs"), { recursive: true });
    mkdirSync(join(captureDir, "src"), { recursive: true });
    cpSync(join(ROOT, "test/fixtures/trace/cjs"), join(captureDir, "node_modules", "tiny-trace-cjs"), {
      recursive: true,
    });
    writeFileSync(join(captureDir, "package.json"), JSON.stringify({ name: "app", type: "commonjs" }));
    writeFileSync(
      join(captureDir, "src", "index.test.js"),
      `const { test } = require("node:test");
const assert = require("node:assert/strict");
const { add } = require("tiny-trace-cjs");
test("add", () => { assert.equal(add(2, 3), 5); });
`,
    );
    const srcHook = join(ROOT, "src/trace/hook.ts");
    const srcEvents = captureHook(srcHook, captureDir, join(captureDir, "traces-src.jsonl"), [
      "--experimental-strip-types",
    ]);
    const pkgEvents = captureHook(hookJs, captureDir, join(captureDir, "traces-pkg.jsonl"), []);
    assert.deepEqual(pkgEvents, srcEvents);

    const vitestLoad = run(
      process.execPath,
      [
        "-e",
        `import(${JSON.stringify(pathToFileURL(vitestJs).href)}).then((m) => {
          if (typeof m.slimVitest !== "function" && typeof m.default !== "function") process.exit(1);
          console.log("vitest-ok");
        })`,
      ],
      proj,
    );
    assert.equal(vitestLoad.status, 0, vitestLoad.stderr);
    assert.match(vitestLoad.stdout, /vitest-ok/);

    const workerLoad = run(
      process.execPath,
      [
        "-e",
        `import(${JSON.stringify(pathToFileURL(workersJs).href)}).then((m) => {
          const u = m.workerThreadUrl();
          if (!String(u.href).endsWith("worker-thread.js")) process.exit(1);
          console.log(u.href);
        })`,
      ],
      proj,
    );
    assert.equal(workerLoad.status, 0, workerLoad.stderr);
    assert.match(workerLoad.stdout, /worker-thread\.js/);

    const help = run(installedBin[0]!, installedBin.slice(1).concat(["--help"]), proj);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Exit codes:/);
    assert.equal(help.stderr, "");

    const usage = run(installedBin[0]!, installedBin.slice(1).concat(["nope"]), proj);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /unknown command/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(packDir, { recursive: true, force: true });
  }
});

function captureHook(
  hookPath: string,
  cwd: string,
  outPath: string,
  extraArgs: string[],
): unknown[] {
  const r = run(
    process.execPath,
    [...extraArgs, "--import", pathToFileURL(hookPath).href, "--test", "src/index.test.js"],
    cwd,
    { SLIM_TRACE_PACKAGES: "tiny-trace-cjs", SLIM_TRACE_OUT: outPath },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return canonicalizeTraces(readFileSync(outPath, "utf8"));
}

function canonicalizeTraces(jsonl: string): unknown[] {
  return jsonl
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (o.t === "session") return { t: "session", hook: o.hook, v: o.v };
      delete o.sessionId;
      delete o.originId;
      delete o.parentOriginId;
      delete o.tRelMs;
      if (o.site && typeof o.site === "object") {
        const s = o.site as { line: number; column: number };
        o.site = { line: s.line, column: s.column };
      }
      return o;
    });
}
