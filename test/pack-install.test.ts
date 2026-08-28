import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { execPm, spawnPm, cmdShimSpawnOpts } from "../src/rewrite/lockfile.ts";
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
import { npmPackTo, withRepoDistLock } from "./helpers/llm-replace.ts";

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
    ...cmdShimSpawnOpts(bin),
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function ensureDist(): void {
  if (!existsSync(join(ROOT, "dist", ".slim-build.json"))) {
    execPm("npm", ["run", "build"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  }
}

test("npm pack contains dist CLI, catalog sources, schema, actions; excludes tests", { timeout: 120_000 }, () => {
  ensureDist();
  const pack = withRepoDistLock(() =>
    String(
      execPm("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 30_000,
      }),
    ),
  );
  const parsed = JSON.parse(pack) as Array<{ files: Array<{ path: string }> }>;
  const files = new Set((parsed[0]?.files ?? []).map((f) => f.path.replace(/\\/g, "/")));

  const required = [
    "dist/main.js",
    "dist/main.d.ts",
    "dist/trace/hook.js",
    "dist/fuzz/worker-thread.js",
    "dist/trace/vitest.js",
    "dist/github/check-action.js",
    "dist/github/bloat-action.js",
    "dist/github/upstream-action.js",
    "dist/generate/catalog/_internal.ts",
    "dist/generate/catalog/lodash.get.ts",
    "action/run.mjs",
    "action/digest.mjs",
    "action/check/action.yml",
    "action/bloat/action.yml",
    "action/upstream/action.yml",
    "slim.schema.json",
    "docs/slim.schema.json",
    "docs/scan.schema.json",
    "docs/error.schema.json",
    "docs/support-inventory.json",
    "CHANGELOG.md",
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

test("npm publish --dry-run lists the same production files", { timeout: 120_000 }, () => {
  ensureDist();
  const packOut = withRepoDistLock(() =>
    String(
      execPm("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60_000,
      }),
    ),
  );
  const packed = JSON.parse(packOut) as Array<{ files?: Array<{ path: string }> }> | { files?: Array<{ path: string }> };
  const packList = (Array.isArray(packed) ? packed[0]?.files : packed.files) ?? [];
  const files = new Set(packList.map((f) => f.path.replace(/\\/g, "/")));
  assert.ok(files.has("dist/main.js"), "publish dry-run missing dist/main.js");
  assert.ok(files.has("CHANGELOG.md"), "publish dry-run missing CHANGELOG.md");
  assert.ok(files.has("docs/scan.schema.json"), "publish dry-run missing command schema");
  for (const f of files) {
    assert.ok(!f.startsWith("test/"), `publish dry-run leaked ${f}`);
    assert.ok(!f.startsWith("src/"), `publish dry-run leaked ${f}`);
    assert.ok(!f.includes(".env"), `publish dry-run leaked ${f}`);
  }
  const publish = withRepoDistLock(() =>
    spawnPm("npm", ["publish", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
    }),
  );
  if ((publish.status ?? 1) !== 0) {
    assert.match(
      `${publish.stdout ?? ""}\n${publish.stderr ?? ""}`,
      /cannot publish over the previously published versions/i,
    );
  }
});

test("installed tarball CLI matches source for help, doctor, scan --json, inspect, replace --dry-run", { timeout: 180_000 }, () => {
  ensureDist();
  const packDir = mkdtempSync(join(tmpdir(), "slim-install-pack-"));
  const tarball = npmPackTo(packDir);
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
    execPm("npm", ["install", tarball, "--omit=dev"], {
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

    const starDir = join(tmp, "trace-star");
    mkdirSync(join(starDir, "node_modules", "tiny-trace-star"), { recursive: true });
    mkdirSync(join(starDir, "src"), { recursive: true });
    cpSync(join(ROOT, "test/fixtures/trace/esm-star"), join(starDir, "node_modules", "tiny-trace-star"), {
      recursive: true,
    });
    writeFileSync(join(starDir, "package.json"), JSON.stringify({ name: "app", type: "module" }));
    writeFileSync(
      join(starDir, "src", "index.test.js"),
      `import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "tiny-trace-star";
test("add", () => { assert.equal(add(2, 3), 5); });
`,
    );
    const srcStar = captureHook(
      srcHook,
      starDir,
      join(starDir, "traces-src.jsonl"),
      ["--experimental-strip-types"],
      "tiny-trace-star",
    );
    const pkgStar = captureHook(hookJs, starDir, join(starDir, "traces-pkg.jsonl"), [], "tiny-trace-star");
    assert.deepEqual(pkgStar, srcStar);
    assert.equal(
      srcStar.some((e) => typeof e === "object" && e !== null && (e as { symbol?: string }).symbol === "add"),
      true,
    );

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

    const resolved = run(
      process.execPath,
      [
        "-e",
        `import { createRequire } from "node:module";
         import { pathToFileURL } from "node:url";
         const req = createRequire(pathToFileURL(${JSON.stringify(join(tmp, "package.json"))}).href);
         for (const spec of ["slim", "slim/hooks", "slim/vitest"]) {
           const r = req.resolve(spec);
           if (!r) process.exit(1);
           console.log(spec, r);
         }`,
      ],
      tmp,
    );
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.match(resolved.stdout, /slim .*main\.js/);
    assert.match(resolved.stdout, /slim\/hooks .*hook\.js/);
    assert.match(resolved.stdout, /slim\/vitest .*vitest\.js/);

    const binName = process.platform === "win32" ? "slim.cmd" : "slim";
    const binPath = join(tmp, "node_modules", ".bin", binName);
    const binHelp = run(binPath, ["--help"], proj);
    assert.equal(binHelp.status, 0, binHelp.stderr);
    assert.match(binHelp.stdout, /Exit codes:/);

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
  pkg = "tiny-trace-cjs",
): unknown[] {
  const r = run(
    process.execPath,
    [...extraArgs, "--import", pathToFileURL(hookPath).href, "--test", "src/index.test.js"],
    cwd,
    { SLIM_TRACE_PACKAGES: pkg, SLIM_TRACE_OUT: outPath },
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
