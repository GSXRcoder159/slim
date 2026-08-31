import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  cpSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hermeticPmEnv, execPm, cmdShimSpawnOpts } from "../src/rewrite/lockfile.ts";
import { npmPackTo, installPackedTarball } from "./helpers/llm-replace.ts";
import { packageNodeModulesDir } from "../src/release/identity.ts";
import { createParityCases, type ParityCase } from "./fuzz/parity-corpus.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = tmpdir();

function run(
  bin: string,
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs = 180_000,
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    env: hermeticPmEnv({ ...extraEnv }),
    timeout: timeoutMs,
    ...cmdShimSpawnOpts(bin),
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function packTarball(): { dir: string; tarball: string } {
  mkdirSync(TMP, { recursive: true });
  execPm("npm", ["run", "build"], { cwd: ROOT, encoding: "utf8", timeout: 240_000, env: hermeticPmEnv() });
  const dir = mkdtempSync(join(TMP, "slim-graph-pack-"));
  return { dir, tarball: npmPackTo(dir) };
}

function copyFixture(name: string, dest: string): void {
  const src = join(ROOT, "fixtures", name);
  cpSync(src, dest, {
    recursive: true,
    filter: (p) => {
      const rel = relative(src, p).replace(/\\/g, "/");
      if (!rel || rel === ".") return true;
      if (rel.split(/[/\\]/)[0] === "node_modules") return false;
      if (rel.startsWith("src/slim") || rel.startsWith(".slim")) return false;
      if (rel === "package-lock.json" || rel === "slim.json") return false;
      return true;
    },
  });
}

function installSlim(cwd: string, tarball: string): void {
  installPackedTarball(cwd, tarball);
}

function slimRootOf(cwd: string): string {
  return packageNodeModulesDir(cwd);
}

function slimJs(cwd: string): string {
  return join(slimRootOf(cwd), "dist", "main.js");
}

type PackedEq = {
  equalResults: (
    orig: unknown,
    slim: unknown,
    hyrum?: unknown,
  ) => { ok: boolean };
  invoke: (fn: Function, args: unknown[], thisArg?: unknown) => unknown;
  normalizeError: (e: unknown) => { name: string; message: string; code?: unknown };
};

async function loadPacked(slimRoot: string) {
  const href = (rel: string) => pathToFileURL(join(slimRoot, rel)).href;
  const equal = (await import(href("dist/fuzz/equal.js"))) as PackedEq;
  const clone = (await import(href("dist/fuzz/clone.js"))) as {
    cloneInvocation: (args: unknown[], thisArg?: unknown) => { args: unknown[]; thisArg?: unknown };
  };
  const ser = (await import(href("dist/trace/serialize.js"))) as {
    createWalker: () => { value: (v: unknown) => unknown };
  };
  const standingMod = (await import(href("dist/evidence/standing-equal.js"))) as {
    STANDING_RUNTIME: string;
  };
  const types = (await import(href("dist/envelope/types.js"))) as {
    emptyHyrum: () => Record<string, boolean>;
  };
  const standing = new Function(
    `${standingMod.STANDING_RUNTIME}\nreturn { checkFrozenPair, standingEqual, decode };`,
  )() as {
    checkFrozenPair: (fn: Function, p: unknown) => void;
    standingEqual: (a: unknown, b: unknown, hyrum?: unknown) => boolean;
    decode: (v: unknown, seen: unknown[]) => unknown;
  };
  return { equal, clone, ser, types, standing };
}

function freezePairPacked(
  packed: Awaited<ReturnType<typeof loadPacked>>,
  orig: Function,
  args: unknown[],
  thisArg: unknown,
  hyrum: unknown,
) {
  const { args: liveArgs, thisArg: liveThis } = packed.clone.cloneInvocation(args, thisArg);
  const before = packed.ser.createWalker();
  const argsSv = liveArgs.map((a) => before.value(a));
  const thisSv =
    liveThis === undefined || liveThis === null ? null : before.value(liveThis);
  let threw: { name: string; message: string; code?: unknown } | null = null;
  let resultSv: unknown = null;
  try {
    resultSv = before.value(orig.apply(liveThis, liveArgs));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/without ['"]?new['"]?/i.test(msg) || /Class constructor/i.test(msg)) {
      try {
        resultSv = before.value(Reflect.construct(orig, liveArgs));
      } catch (e2) {
        threw = packed.equal.normalizeError(e2);
      }
    } else {
      threw = packed.equal.normalizeError(e);
    }
  }
  const after = packed.ser.createWalker();
  return {
    symbol: "fn",
    args: argsSv,
    thisArg: thisSv,
    threw,
    result: threw ? null : resultSv,
    hyrum: { ...packed.types.emptyHyrum(), ...(hyrum as object) },
    argsAfter: liveArgs.map((a) => after.value(a)),
    thisAfter:
      liveThis === undefined || liveThis === null ? null : after.value(liveThis),
  };
}

function runPackedCase(packed: Awaited<ReturnType<typeof loadPacked>>, c: ParityCase) {
  const fuzzGood = packed.equal.equalResults(
    packed.equal.invoke(c.orig, c.args, c.thisArg),
    packed.equal.invoke(c.good, c.args, c.thisArg),
    c.hyrum,
  );
  const fuzzBad = packed.equal.equalResults(
    packed.equal.invoke(c.orig, c.args, c.thisArg),
    packed.equal.invoke(c.bad, c.args, c.thisArg),
    c.hyrum,
  );
  assert.equal(fuzzGood.ok, true, `${c.name}: packed fuzz good`);
  assert.equal(fuzzBad.ok, false, `${c.name}: packed fuzz bad`);
  if (c.standing === "live") {
    const origOut = packed.equal.invoke(c.orig, c.args, c.thisArg) as { ok: boolean; value: unknown };
    const goodOut = packed.equal.invoke(c.good, c.args, c.thisArg) as { ok: boolean; value: unknown };
    const badOut = packed.equal.invoke(c.bad, c.args, c.thisArg) as { ok: boolean; value: unknown };
    assert.equal(
      origOut.ok && goodOut.ok && packed.standing.standingEqual(origOut.value, goodOut.value, c.hyrum),
      true,
      `${c.name}: packed standing live good`,
    );
    assert.equal(
      badOut.ok && packed.standing.standingEqual(origOut.ok ? origOut.value : null, badOut.value, c.hyrum),
      false,
      `${c.name}: packed standing live bad`,
    );
    return;
  }
  const pair = freezePairPacked(packed, c.orig, c.args, c.thisArg, c.hyrum);
  try {
    packed.standing.checkFrozenPair(c.good, pair);
  } catch (e) {
    assert.fail(`${c.name}: packed standing good: ${e instanceof Error ? e.message : e}`);
  }
  try {
    packed.standing.checkFrozenPair(c.bad, pair);
    assert.fail(`${c.name}: packed standing bad should reject`);
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
  }
}

function writeLodashConsumer(dest: string): void {
  writeFileSync(
    join(dest, "src", "index.ts"),
    `import _ from "lodash";

export function pickUser(user: { profile?: { name?: string | null } } | null): string {
  return _.get(user, "profile.name", "anonymous") as string;
}

export function nestedRef(obj: { a: { b: { c: number } } }) {
  return _.get(obj, "a.b");
}

export function nestedRefPath(obj: { a: { b: { c: number } } }) {
  return _.get(obj, ["a", "b"]);
}

export const ping = _.debounce((n: number) => n, 50);

export function schedule(fn: () => void): ReturnType<typeof _.debounce> {
  return _.debounce(fn, 25);
}

export function badDebounce(): ReturnType<typeof _.debounce> {
  return _.debounce(null as never, 10);
}
`,
  );
  const pkgPath = join(dest, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  pkg.dependencies = { ...(pkg.dependencies ?? {}), lodash: "4.17.21" };
  pkg.scripts = {
    ...(pkg.scripts ?? {}),
    test: "node --experimental-strip-types --test src/index.test.ts",
  };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

function breakGetIdentity(modPath: string): void {
  const src = readFileSync(modPath, "utf8");
  const next = src.replace(
    /export function get\(object: unknown, path: unknown, defaultValue\?: unknown\): unknown \{\n  const resolved = object == null \? undefined : baseGet\(object, path\);\n  return resolved === undefined \? defaultValue : resolved;\n\}/,
    `export function get(object: unknown, path: unknown, defaultValue?: unknown): unknown {
  const resolved = object == null ? undefined : baseGet(object, path);
  if (resolved !== undefined && resolved !== null && typeof resolved === "object") {
    return { ...(resolved as object) };
  }
  return resolved === undefined ? defaultValue : resolved;
}`,
  );
  assert.notEqual(next, src, "cloning get did not match generated get");
  writeFileSync(modPath, next);
}

test("packed corpus, replace, check, and cloning get share the graph contract", { timeout: 300_000 }, async () => {
  const { dir: packDir, tarball } = packTarball();
  const host = mkdtempSync(join(TMP, "slim-graph-host-"));
  const dest = mkdtempSync(join(TMP, "slim-graph-lodash-"));
  try {
    writeFileSync(join(host, "package.json"), JSON.stringify({ name: "host", private: true, type: "module" }));
    installSlim(host, tarball);
    const packed = await loadPacked(slimRootOf(host));
    for (const c of createParityCases()) runPackedCase(packed, c);

    const before = Object.prototype.hasOwnProperty("polluted");
    packed.standing.decode(
      {
        t: "obj",
        keys: ["__proto__", "constructor", "prototype"],
        v: {
          __proto__: { t: "obj", keys: ["polluted"], v: { polluted: { t: "bool", v: true } } },
          constructor: { t: "num", v: 1 },
          prototype: { t: "num", v: 2 },
        },
      },
      [],
    );
    assert.equal(Object.prototype.hasOwnProperty("polluted"), before);

    copyFixture("lodash-get-debounce", dest);
    writeLodashConsumer(dest);
    installSlim(dest, tarball);
    const bin = slimJs(dest);
    const replaced = run(
      process.execPath,
      [bin, "replace", "lodash", "--no-pr", "--budget-ms", "800", "--workers", "1", "--seed", "1"],
      dest,
    );
    assert.equal(replaced.status, 0, replaced.stderr + replaced.stdout);
    const standingPath = join(dest, "src/slim/lodash.test.ts");
    const modulePath = join(dest, "src/slim/lodash.ts");
    assert.ok(existsSync(standingPath));
    assert.ok(existsSync(modulePath));
    const standing = readFileSync(standingPath, "utf8");
    const slice = readFileSync(modulePath, "utf8");
    assert.match(standing, /checkFrozenPair/);
    assert.doesNotMatch(standing, /from ["']lodash["']/);
    assert.doesNotMatch(slice, /from ["']lodash["']/);
    assert.match(standing, /cancel-mid/);
    assert.match(standing, /flush-mid/);
    assert.ok(
      standing.includes('"sameReference": true') || standing.includes('"t": "ref"'),
      "standing pairs must record nested identity",
    );
    const stood = run(process.execPath, ["--experimental-strip-types", "--test", "src/slim/lodash.test.ts"], dest);
    assert.equal(stood.status, 0, stood.stderr + stood.stdout);
    const checked = run(process.execPath, [bin, "check"], dest);
    assert.equal(checked.status, 0, checked.stderr + checked.stdout);

    breakGetIdentity(modulePath);
    const stoodBad = run(
      process.execPath,
      ["--experimental-strip-types", "--test", "src/slim/lodash.test.ts"],
      dest,
    );
    assert.notEqual(stoodBad.status, 0, stoodBad.stdout + stoodBad.stderr);
    const checkedBad = run(process.execPath, [bin, "check"], dest);
    assert.notEqual(checkedBad.status, 0, checkedBad.stdout + checkedBad.stderr);
  } finally {
    rmSync(host, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
    rmSync(packDir, { recursive: true, force: true });
  }
});
