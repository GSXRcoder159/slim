import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "../src/project.ts";
import { analyzePackage } from "../src/analyze/index.ts";
import { parseCli } from "../src/cli.ts";
import { runInspect } from "../src/inspect.ts";
import type { Envelope } from "../src/envelope/types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test/fixtures/analyze");

function linkTypescript(root: string) {
  const tsDir = dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
  mkdirSync(join(root, "node_modules"), { recursive: true });
  const dest = join(root, "node_modules", "typescript");
  if (!existsSync(dest)) symlinkSync(tsDir, dest);
}

function mini(files: Record<string, string>, extraPkg: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "slim-p3-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "mini",
      type: "module",
      dependencies: { lodash: "^4.17.21" },
      devDependencies: { typescript: "^5.9.0" },
      ...extraPkg,
    }),
  );
  for (const [p, body] of Object.entries(files)) {
    const abs = join(root, p);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  linkTypescript(root);
  return root;
}

function exportNames(env: Envelope) {
  return env.symbols.map((s) => s.exportName).sort();
}

function getSites(env: Envelope) {
  return env.symbols.find((s) => s.exportName === "get")?.callSites ?? [];
}

async function captureInspect(argv: string[]) {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await runInspect(parseCli(argv));
    return { code, out: chunks.join("") };
  } finally {
    process.stdout.write = orig;
  }
}

test("committed analyze fixtures type-check", () => {
  const tsDir = dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
  const tsc = join(tsDir, "bin", "tsc");
  const r = spawnSync(process.execPath, [tsc, "--noEmit", "-p", FIXTURE], { encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});

test("call-site ids are stable across nested cwd", () => {
  const root = mini({
    "src/app.ts": `import { get } from "lodash"; export const v = get({ a: 1 }, "a");`,
    "nested/.keep": "",
  });
  const fromRoot = analyzePackage(loadProject(root), "lodash");
  const cwd = process.cwd();
  process.chdir(join(root, "nested"));
  try {
    const fromNested = analyzePackage(loadProject(root), "lodash");
    const ids = (env: Envelope) =>
      [...env.symbols.flatMap((s) => s.callSites.map((c) => c.id)), ...env.unknowns.map((u) => u.id)].sort();
    assert.deepEqual(ids(fromNested), ids(fromRoot));
    assert.ok(ids(fromRoot).every((id) => !id.includes(root)));
    assert.ok(ids(fromRoot).some((id) => id.startsWith("call:src/")));
  } finally {
    process.chdir(cwd);
  }
});

test("chained require, Function(), dynamic require, nested array, .call peel", () => {
  linkTypescript(FIXTURE);
  const project = loadProject(FIXTURE);

  const chained = analyzePackage(project, "lodash", { include: ["chained.cjs"] });
  assert.ok(exportNames(chained).includes("get"), `symbols=${exportNames(chained)}`);

  const fn = analyzePackage(project, "lodash", { include: ["eval-fn.ts"] });
  assert.ok(fn.unknowns.some((u) => u.kind === "eval" && u.detail.includes("Function()")));
  assert.ok(fn.unknowns.some((u) => u.kind === "eval" && u.detail.includes("new Function")));
  assert.ok(fn.unknowns.some((u) => u.kind === "eval" && /eval\(\)/.test(u.detail)));
  assert.equal(fn.closure.confidence, "open");
  assert.equal(fn.closure.readyToGenerate, false);

  const dynReq = analyzePackage(project, "lodash", { include: ["dynamic-require.ts"] });
  assert.ok(dynReq.unknowns.some((u) => u.kind === "dynamic-specifier" && /require/.test(u.detail)));

  const named = analyzePackage(project, "lodash", { include: ["named.ts"] });
  const gets = getSites(named);
  assert.ok(gets.some((c) => c.argc.observed[0] === 2));
  assert.ok(gets.some((c) => c.argc.observed[0] === 3));
  const nested = gets.find((c) => c.argc.observed[0] === 3)?.argShapes[2];
  assert.equal(nested?.kind, "array");
  assert.equal(nested?.elements?.length, 2);
  assert.equal(nested?.elements?.[0]?.kind, "array");

  const cab = analyzePackage(project, "lodash", { include: ["call-apply-bind.ts"] });
  const sites = getSites(cab);
  assert.ok(sites.some((c) => c.thisBinding.kind === "call"));
  assert.ok(sites.some((c) => c.thisBinding.kind === "apply"));
  assert.ok(sites.some((c) => c.thisBinding.kind === "bind"));
  assert.equal(
    sites.some((c) => c.memberPath.includes("call") || c.memberPath.includes("apply") || c.memberPath.includes("bind")),
    false,
  );
  assert.equal(sites.find((c) => c.thisBinding.kind === "call")?.argc.observed[0], 2);

  const nsEsc = analyzePackage(project, "lodash", { include: ["namespace-escape.ts"] });
  assert.ok(nsEsc.unknowns.some((u) => u.kind === "namespace-escape"));
  assert.equal(nsEsc.unknowns.find((u) => u.kind === "namespace-escape")?.widensTo, "all-exports");
});

test("equivalent import styles share get export", () => {
  linkTypescript(FIXTURE);
  const project = loadProject(FIXTURE);
  const styles: Array<string | string[]> = [
    "named.ts",
    "default.ts",
    "namespace.ts",
    "alias.ts",
    ["from-reexport.ts", "reexport.ts", "barrel.ts"],
    "cjs.cjs",
    "chained.cjs",
  ];
  for (const file of styles) {
    const include = Array.isArray(file) ? file : [file];
    const env = analyzePackage(project, "lodash", { include });
    assert.ok(exportNames(env).includes("get"), `missing get from ${include.join(",")}: ${exportNames(env)}`);
  }
});

test("env detector is independent per signal", () => {
  for (const dir of ["browser", "worker", "node", "jsdom"] as const) {
    linkTypescript(join(FIXTURE, "env", dir));
  }
  const browser = analyzePackage(loadProject(join(FIXTURE, "env/browser")), "lodash");
  assert.ok(browser.env.includes("browser"));
  assert.equal(browser.env.includes("node"), false);

  const worker = analyzePackage(loadProject(join(FIXTURE, "env/worker")), "lodash");
  assert.ok(worker.env.includes("worker"));
  assert.equal(worker.env.includes("node"), false);

  const node = analyzePackage(loadProject(join(FIXTURE, "env/node")), "lodash");
  assert.ok(node.env.includes("node"));
  assert.equal(node.env.includes("browser"), false);

  const jsdom = analyzePackage(loadProject(join(FIXTURE, "env/jsdom")), "lodash");
  assert.ok(jsdom.env.includes("jsdom"));
  assert.equal(jsdom.env.includes("node"), false);

  const unknown = analyzePackage(
    loadProject(mini({ "src/app.ts": `export const n = 1;` }, { dependencies: {} })),
    "lodash",
  );
  assert.deepEqual(unknown.env, ["unknown"]);
});

test("inspect --json shape; open envelope exits 3; allow-unknown never closed", async () => {
  const openRoot = mini({
    "src/app.ts": `
      import _ from "lodash";
      export function f(k: string) { return (_ as any)[k]({}); }
    `,
  });
  const cwd = process.cwd();
  process.chdir(openRoot);
  try {
    const refused = await captureInspect(["inspect", "lodash", "--json"]);
    assert.equal(refused.code, 3);
    const doc = JSON.parse(refused.out) as {
      envelope: Envelope;
      hash: string;
      decision: string;
      reason: string;
    };
    assert.equal(doc.decision, "refuse");
    assert.ok(doc.hash);
    assert.equal(doc.envelope.closure.readyToGenerate, false);
    assert.ok(Array.isArray(doc.envelope.closure.staticCallSiteIds));
    assert.deepEqual(doc.envelope.closure.tracedCallSiteIds, []);

    const allowed = await captureInspect(["inspect", "lodash", "--json", "--allow-unknown"]);
    assert.equal(allowed.code, 0);
    const allowedDoc = JSON.parse(allowed.out) as {
      envelope: Envelope;
      decision: string;
      reason: string;
    };
    assert.equal(allowedDoc.decision, "try");
    assert.equal(allowedDoc.envelope.closure.confidence, "open");
    assert.match(allowedDoc.reason, /--allow-unknown/);
  } finally {
    process.chdir(cwd);
  }

  const closedRoot = mini({
    "src/app.ts": `import { get } from "lodash"; export const v = get({ a: 1 }, "a");`,
  });
  process.chdir(closedRoot);
  try {
    const ok = await captureInspect(["inspect", "lodash"]);
    assert.equal(ok.code, 0);
    assert.match(ok.out, /confidence/);
    assert.doesNotMatch(ok.out, /"decision"/);
  } finally {
    process.chdir(cwd);
  }
});
