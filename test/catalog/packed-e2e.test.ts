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
import { fileURLToPath } from "node:url";

import { hermeticPmEnv, execPm, cmdShimSpawnOpts } from "../../src/rewrite/lockfile.ts";
import { applyRevert, type RevertPlan } from "../../src/rewrite/revert.ts";
import { npmPackTo, withRepoDistLock } from "../helpers/llm-replace.ts";
import { packageNodeModulesDir } from "../../src/release/identity.ts";
import {
  allCatalogEntries,
  CATALOG_PKG_ALIAS,
  LODASH_PER_METHOD_ORACLES,
  LODASH_SYMBOLS,
  lodashNpmName,
} from "../../src/generate/catalog/index.ts";
import { canonicalInventory } from "../../src/support/inventory.ts";
import { lodashAllSymbolsSource, lodashMethodConsumer } from "./packed-consumers.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = tmpdir();

const PACKAGE_CASES: Array<{ dir: string; pkg: string; lodashInput?: "typical" | "all" }> = [
  { dir: "lodash-get-debounce", pkg: "lodash", lodashInput: "typical" },
  { dir: "moment-format", pkg: "moment" },
  { dir: "uuid-v4", pkg: "uuid" },
  { dir: "clsx-join", pkg: "clsx" },
  { dir: "ms-parse", pkg: "ms" },
  { dir: "nanoid-id", pkg: "nanoid" },
  { dir: "whatwg-url-host", pkg: "whatwg-url" },
  { dir: "bluebird-delay", pkg: "bluebird" },
  { dir: "mime-types-lookup", pkg: "mime-types" },
];

function npmEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = hermeticPmEnv({ ...extra, npm_config_update_notifier: "false" });
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  return env;
}

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
    env: npmEnv(extraEnv),
    timeout: timeoutMs,
    ...cmdShimSpawnOpts(bin),
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function copyFixture(name: string, dest: string, lodashInput?: "typical" | "all"): void {
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
  if (lodashInput === "typical") {
    writeFileSync(
      join(dest, "src/index.ts"),
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
    setDeps(dest, { lodash: "4.17.21" });
  }
}

function setDeps(dest: string, deps: Record<string, string>, drop: string[] = []): void {
  const pkgPath = join(dest, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  const next = { ...(pkg.dependencies ?? {}), ...deps };
  for (const name of drop) delete next[name];
  pkg.dependencies = next;
  pkg.scripts = {
    ...(pkg.scripts ?? {}),
    test: "node --experimental-strip-types --test src/index.test.ts",
  };
  delete pkg.scripts["slim:evidence"];
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

function stemOf(pkg: string): string {
  return pkg.replace(/^@/, "").replace(/\//g, "-");
}

function assertReplaceLoop(dest: string, pkg: string, slimJs: string, budgetMs = 800): void {
  const indexBefore = readFileSync(join(dest, "src/index.ts"), "utf8");
  const pkgBefore = readFileSync(join(dest, "package.json"), "utf8");
  const replaced = run(
    process.execPath,
    [slimJs, "replace", pkg, "--no-pr", "--budget-ms", String(budgetMs), "--workers", "1"],
    dest,
  );
  assert.equal(
    replaced.status,
    0,
    `${pkg} replace failed\nstdout:\n${replaced.stdout}\nstderr:\n${replaced.stderr}`,
  );
  const stem = stemOf(pkg);
  const slimMod = join(dest, "src", "slim", `${stem}.ts`);
  assert.ok(existsSync(slimMod), `${pkg}: missing generated slice`);
  const slice = readFileSync(slimMod, "utf8");
  assert.doesNotMatch(slice, new RegExp(`from ['"]${pkg.replace(".", "\\.")}['"]`));
  const pkgJson = JSON.parse(readFileSync(join(dest, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(pkgJson.dependencies?.[pkg], undefined, `${pkg} still in package.json`);
  const standing = join(dest, "src", "slim", `${stem}.test.ts`);
  assert.ok(existsSync(standing), `${pkg}: missing standing tests`);
  const stood = run(process.execPath, ["--experimental-strip-types", "--test", standing], dest);
  assert.equal(
    stood.status,
    0,
    `${pkg} standing tests failed\nstdout:\n${stood.stdout}\nstderr:\n${stood.stderr}`,
  );
  const checked = run(process.execPath, [slimJs, "check"], dest);
  assert.equal(
    checked.status,
    0,
    `${pkg} check failed\nstdout:\n${checked.stdout}\nstderr:\n${checked.stderr}`,
  );
  const evidenceMd = join(dest, ".slim", stem, "evidence.md");
  const evidenceJson = join(dest, ".slim", stem, "evidence.json");
  assert.ok(existsSync(evidenceMd), `${pkg}: missing evidence.md`);
  assert.ok(existsSync(evidenceJson), `${pkg}: missing evidence.json`);
  const evidence = JSON.parse(readFileSync(evidenceJson, "utf8")) as {
    fuzz?: { comparisons?: number };
    revert?: RevertPlan;
  };
  assert.ok((evidence.fuzz?.comparisons ?? 0) > 0, `${pkg}: evidence.fuzz.comparisons`);
  assert.ok(evidence.revert, `${pkg}: missing revert plan`);
  applyRevert(dest, evidence.revert!);
  const pkgAfter = JSON.parse(readFileSync(join(dest, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.ok(pkgAfter.dependencies?.[pkg], `${pkg}: revert did not restore dependency`);
  assert.equal(existsSync(slimMod), false, `${pkg}: slice remained after revert`);
  assert.equal(existsSync(standing), false, `${pkg}: standing tests remained after revert`);
  const indexAfter = readFileSync(join(dest, "src/index.ts"), "utf8");
  assert.match(indexAfter, new RegExp(`['"]${pkg.replace(".", "\\.")}['"]`), `${pkg}: import not restored`);
  assert.notEqual(pkgAfter.dependencies?.[pkg], undefined);
  void indexBefore;
  void pkgBefore;
}

function npmInstall(cwd: string, tarball: string): void {
  execPm("npm", ["install", tarball], {
    cwd,
    encoding: "utf8",
    timeout: 300_000,
    env: npmEnv(),
  });
}

function writeGenerated(dest: string, index: string, testSrc: string, deps: Record<string, string>, drop: string[]): void {
  mkdirSync(join(dest, "src"), { recursive: true });
  writeFileSync(join(dest, "src/index.ts"), index);
  writeFileSync(join(dest, "src/index.test.ts"), testSrc);
  rmSync(join(dest, "src/worker.ts"), { force: true });
  setDeps(dest, deps, drop);
}

const PACKED_PKG_ALIASES: Array<{
  alias: string;
  fixture: string;
  lodashInput?: "typical";
  rewriteLodashSpecifier?: boolean;
  index?: string;
  testSrc?: string;
  deps: Record<string, string>;
  drop: string[];
}> = [
  {
    alias: "lodash-es",
    fixture: "lodash-get-debounce",
    lodashInput: "typical",
    rewriteLodashSpecifier: true,
    deps: { "lodash-es": "4.17.21" },
    drop: ["lodash"],
  },
  {
    alias: "underscore",
    fixture: "lodash-get-debounce",
    index: `import _ from "underscore";

export function pickUser(user: { profile?: { name?: string | null } } | null): string {
  return _.get(user, ["profile", "name"], "anonymous") as string;
}
`,
    testSrc: `import { test } from "node:test";
import assert from "node:assert/strict";
import { pickUser } from "./index.ts";

test("get default only when undefined", () => {
  assert.equal(pickUser({ profile: { name: "Ada" } }), "Ada");
  assert.equal(pickUser({}), "anonymous");
});
`,
    deps: { underscore: "npm:lodash@4.17.21" },
    drop: ["lodash"],
  },
  {
    alias: "classnames",
    fixture: "clsx-join",
    index: `import classnames from "classnames";

export function classes(active: boolean): string {
  return classnames("btn", active ? "btn-active" : "", "px-2");
}
`,
    testSrc: `import { test } from "node:test";
import assert from "node:assert/strict";
import { classes } from "./index.ts";
test("joins", () => {
  assert.equal(classes(true), "btn btn-active px-2");
});
`,
    deps: { classnames: "2.5.1" },
    drop: ["clsx"],
  },
  {
    alias: "mime",
    fixture: "mime-types-lookup",
    index: `import { lookup } from "mime";

export function typeOf(path: string): string | false {
  return lookup(path);
}
`,
    testSrc: `import { test } from "node:test";
import assert from "node:assert/strict";
import { typeOf } from "./index.ts";
test("lookup", () => {
  assert.equal(typeOf("index.html"), "text/html");
});
`,
    deps: { mime: "npm:mime-types@2.1.35" },
    drop: ["mime-types"],
  },
  {
    alias: "mime-db",
    fixture: "mime-types-lookup",
    index: `import { lookup } from "mime-db";

export function typeOf(path: string): string | false {
  return lookup(path);
}
`,
    testSrc: `import { test } from "node:test";
import assert from "node:assert/strict";
import { typeOf } from "./index.ts";
test("lookup", () => {
  assert.equal(typeOf("index.html"), "text/html");
});
`,
    deps: { "mime-db": "npm:mime-types@2.1.35" },
    drop: ["mime-types"],
  },
  {
    alias: "url-parse",
    fixture: "whatwg-url-host",
    index: `import { URL } from "url-parse";

export function host(href: string): string {
  return new URL(href).hostname;
}
`,
    testSrc: `import { test } from "node:test";
import assert from "node:assert/strict";
import { host } from "./index.ts";
test("host", () => {
  assert.equal(host("https://example.com/path"), "example.com");
});
`,
    deps: { "url-parse": "npm:whatwg-url@14.2.0" },
    drop: ["whatwg-url"],
  },
];

const PACKED_LODASH_NPM = LODASH_SYMBOLS.map((s) => lodashNpmName(s));

test("packed case table covers every advertised alias and catalog symbol", () => {
  const packed = new Set([
    ...PACKAGE_CASES.map((c) => c.pkg),
    ...PACKED_PKG_ALIASES.map((c) => c.alias),
    ...PACKED_LODASH_NPM,
  ]);
  assert.ok(packed.size > 0, "packed case list must not be empty");
  assert.ok(packed.has(lodashNpmName("set")), "omitting lodash.set must fail completeness");
  assert.deepEqual(
    PACKED_PKG_ALIASES.map((c) => c.alias).sort(),
    Object.keys(CATALOG_PKG_ALIAS).sort(),
  );
  assert.deepEqual(PACKED_LODASH_NPM.slice().sort(), LODASH_SYMBOLS.map(lodashNpmName).sort());
  const inv = canonicalInventory();
  for (const entry of inv.entries) {
    if (entry.kind === "package") {
      assert.ok(
        PACKAGE_CASES.some((c) => c.pkg === entry.name),
        `${entry.id} missing packed package case`,
      );
    }
    if (entry.kind === "alias") {
      if (entry.name.startsWith("lodash.") && !(entry.name in CATALOG_PKG_ALIAS)) {
        const npmName = lodashNpmName(entry.name.slice("lodash.".length));
        assert.ok(packed.has(npmName), `${entry.id} missing packed lodash.* case ${npmName}`);
      } else {
        assert.ok(packed.has(entry.name), `${entry.id} missing packed alias case`);
      }
    }
    if (entry.kind === "symbol") {
      const found = allCatalogEntries().find((e) => e.id === entry.name);
      assert.ok(found, entry.name);
      assert.ok(
        PACKAGE_CASES.some((c) => c.pkg === found!.pkg),
        `${entry.id} package ${found!.pkg} missing packed package case`,
      );
    }
  }
  for (const symbol of LODASH_SYMBOLS) {
    assert.ok(symbol in LODASH_PER_METHOD_ORACLES, `${symbol} missing per-method pin`);
    assert.equal(lodashMethodConsumer(symbol).pkg, lodashNpmName(symbol));
  }
  assert.equal(LODASH_SYMBOLS.length, 33);
  assert.equal(PACKED_PKG_ALIASES.length, 6);
  assert.equal(PACKAGE_CASES.length, 9);
});

test("packed CLI replace → standing tests → slim check → revert for every registered catalog package and alias", { timeout: 3_600_000 }, () => {
  withRepoDistLock(() => {
    execPm("npm", ["run", "build"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
  });
  mkdirSync(TMP, { recursive: true });
  const packDir = mkdtempSync(join(TMP, "slim-catalog-pack-"));
  const tarball = npmPackTo(packDir);
  const tmp = mkdtempSync(join(TMP, "slim-catalog-e2e-"));
  try {
    for (const c of PACKAGE_CASES) {
      const dest = join(tmp, c.dir);
      copyFixture(c.dir, dest, c.lodashInput);
      npmInstall(dest, tarball);
      const slimJs = join(packageNodeModulesDir(dest), "dist", "main.js");
      assert.ok(existsSync(slimJs), `${c.pkg}: installed slim CLI`);
      assertReplaceLoop(dest, c.pkg, slimJs, c.pkg === "lodash" ? 1200 : 800);
    }

    const allLodash = join(tmp, "lodash-all-symbols");
    copyFixture("lodash-get-debounce", allLodash, undefined);
    const allSrc = lodashAllSymbolsSource();
    writeGenerated(allLodash, allSrc.index, allSrc.test, { lodash: "4.17.21" }, []);
    npmInstall(allLodash, tarball);
    assertReplaceLoop(
      allLodash,
      "lodash",
      join(packageNodeModulesDir(allLodash), "dist", "main.js"),
      1600,
    );

    for (const a of PACKED_PKG_ALIASES) {
      const dest = join(tmp, `alias-${a.alias}`);
      copyFixture(a.fixture, dest, a.lodashInput);
      if (a.rewriteLodashSpecifier) {
        writeFileSync(
          join(dest, "src/index.ts"),
          readFileSync(join(dest, "src/index.ts"), "utf8").replaceAll('"lodash"', `"${a.alias}"`),
        );
      } else if (a.index && a.testSrc) {
        writeFileSync(join(dest, "src/index.ts"), a.index);
        writeFileSync(join(dest, "src/index.test.ts"), a.testSrc);
        rmSync(join(dest, "src/worker.ts"), { force: true });
      }
      setDeps(dest, a.deps, a.drop);
      npmInstall(dest, tarball);
      assertReplaceLoop(dest, a.alias, join(packageNodeModulesDir(dest), "dist", "main.js"));
    }

    for (const pkg of PACKED_LODASH_NPM) {
      const symbol = LODASH_SYMBOLS.find((s) => lodashNpmName(s) === pkg);
      assert.ok(symbol, pkg);
      const pin = LODASH_PER_METHOD_ORACLES[symbol];
      assert.ok(pin, `${symbol} pin`);
      const consumer = lodashMethodConsumer(symbol);
      const dest = join(tmp, `alias-${pkg}`);
      copyFixture("lodash-get-debounce", dest);
      writeGenerated(dest, consumer.index, consumer.test, { [pkg]: pin }, ["lodash"]);
      npmInstall(dest, tarball);
      const budget = symbol === "debounce" || symbol === "throttle" ? 800 : 400;
      assertReplaceLoop(dest, pkg, join(packageNodeModulesDir(dest), "dist", "main.js"), budget);
    }

    const refuseLodashEs = join(tmp, "refuse-lodash-es-template");
    copyFixture("lodash-get-debounce", refuseLodashEs);
    writeFileSync(
      join(refuseLodashEs, "src/index.ts"),
      `import { template } from "lodash-es";
export const t = template("<%= a %>");
`,
    );
    writeFileSync(
      join(refuseLodashEs, "src/index.test.ts"),
      `import { test } from "node:test";
import assert from "node:assert/strict";
import { t } from "./index.ts";
test("template compiles", () => {
  assert.equal(typeof t, "function");
});
`,
    );
    setDeps(refuseLodashEs, { "lodash-es": "4.17.21" }, ["lodash"]);
    npmInstall(refuseLodashEs, tarball);
    const slimRefuse = join(packageNodeModulesDir(refuseLodashEs), "dist", "main.js");
    const beforeLodashEs = readFileSync(join(refuseLodashEs, "package.json"), "utf8");
    const refused = run(
      process.execPath,
      [slimRefuse, "replace", "lodash-es", "--no-pr", "--budget-ms", "400", "--workers", "1"],
      refuseLodashEs,
    );
    assert.equal(refused.status, 3, `lodash-es template\n${refused.stdout}\n${refused.stderr}`);
    assert.match(`${refused.stdout}\n${refused.stderr}`, /envelope-too-wide|template/);
    assert.equal(existsSync(join(refuseLodashEs, "src/slim")), false);
    assert.equal(readFileSync(join(refuseLodashEs, "package.json"), "utf8"), beforeLodashEs);

    const refuseMime = join(tmp, "refuse-mime-content-type");
    copyFixture("mime-types-lookup", refuseMime);
    writeFileSync(
      join(refuseMime, "src/index.ts"),
      `import { contentType } from "mime";
export const t = contentType("a.json");
`,
    );
    writeFileSync(
      join(refuseMime, "src/index.test.ts"),
      `import { test } from "node:test";
import assert from "node:assert/strict";
import { t } from "./index.ts";
test("contentType runs", () => {
  assert.ok(t);
});
`,
    );
    setDeps(refuseMime, { mime: "npm:mime-types@2.1.35" }, ["mime-types"]);
    npmInstall(refuseMime, tarball);
    const beforeMime = readFileSync(join(refuseMime, "package.json"), "utf8");
    const mimeRefused = run(
      process.execPath,
      [join(packageNodeModulesDir(refuseMime), "dist", "main.js"), "replace", "mime", "--no-pr", "--budget-ms", "400", "--workers", "1"],
      refuseMime,
    );
    assert.equal(mimeRefused.status, 3, `mime contentType\n${mimeRefused.stdout}\n${mimeRefused.stderr}`);
    assert.match(`${mimeRefused.stdout}\n${mimeRefused.stderr}`, /envelope-too-wide|contentType/);
    assert.equal(existsSync(join(refuseMime, "src/slim")), false);
    assert.equal(readFileSync(join(refuseMime, "package.json"), "utf8"), beforeMime);

    const refuseUrl = join(tmp, "refuse-url-parse-parseURL");
    copyFixture("whatwg-url-host", refuseUrl);
    writeFileSync(
      join(refuseUrl, "src/index.ts"),
      `import { parseURL } from "url-parse";
export const t = parseURL("https://example.com/");
`,
    );
    writeFileSync(
      join(refuseUrl, "src/index.test.ts"),
      `import { test } from "node:test";
import assert from "node:assert/strict";
import { t } from "./index.ts";
test("parseURL runs", () => {
  assert.ok(t);
});
`,
    );
    setDeps(refuseUrl, { "url-parse": "npm:whatwg-url@14.2.0" }, ["whatwg-url"]);
    npmInstall(refuseUrl, tarball);
    const beforeUrl = readFileSync(join(refuseUrl, "package.json"), "utf8");
    const urlRefused = run(
      process.execPath,
      [join(packageNodeModulesDir(refuseUrl), "dist", "main.js"), "replace", "url-parse", "--no-pr", "--budget-ms", "400", "--workers", "1"],
      refuseUrl,
    );
    assert.equal(urlRefused.status, 3, `url-parse parseURL\n${urlRefused.stdout}\n${urlRefused.stderr}`);
    assert.match(`${urlRefused.stdout}\n${urlRefused.stderr}`, /envelope-too-wide|parseURL/);
    assert.equal(existsSync(join(refuseUrl, "src/slim")), false);
    assert.equal(readFileSync(join(refuseUrl, "package.json"), "utf8"), beforeUrl);

    const refuseLocale = join(tmp, "refuse-moment-locale");
    copyFixture("moment-format", refuseLocale);
    writeFileSync(
      join(refuseLocale, "src/index.ts"),
      `import moment from "moment";
export function loc(): string {
  return moment(new Date(2020, 0, 15)).locale("fr").format("YYYY-MM-DD");
}
`,
    );
    writeFileSync(
      join(refuseLocale, "src/index.test.ts"),
      `import { test } from "node:test";
import assert from "node:assert/strict";
import { loc } from "./index.ts";
test("locale", () => {
  assert.equal(typeof loc(), "string");
});
`,
    );
    npmInstall(refuseLocale, tarball);
    const beforeLoc = readFileSync(join(refuseLocale, "package.json"), "utf8");
    const locRefused = run(
      process.execPath,
      [join(packageNodeModulesDir(refuseLocale), "dist", "main.js"), "replace", "moment", "--no-pr", "--budget-ms", "400", "--workers", "1"],
      refuseLocale,
    );
    assert.equal(locRefused.status, 3, `moment locale\n${locRefused.stdout}\n${locRefused.stderr}`);
    assert.match(`${locRefused.stdout}\n${locRefused.stderr}`, /envelope-too-wide|locale/);
    assert.equal(existsSync(join(refuseLocale, "src/slim")), false);
    assert.equal(readFileSync(join(refuseLocale, "package.json"), "utf8"), beforeLoc);

    const refuseUuid = join(tmp, "refuse-uuid-v7");
    copyFixture("uuid-v4", refuseUuid);
    writeFileSync(
      join(refuseUuid, "src/index.ts"),
      `import { v7 } from "uuid";
export function requestId(): string {
  return v7();
}
`,
    );
    writeFileSync(
      join(refuseUuid, "src/index.test.ts"),
      `import { test } from "node:test";
import assert from "node:assert/strict";
import { requestId } from "./index.ts";
test("v7", () => {
  assert.equal(typeof requestId(), "string");
});
`,
    );
    npmInstall(refuseUuid, tarball);
    const beforeUuid = readFileSync(join(refuseUuid, "package.json"), "utf8");
    const uuidRefused = run(
      process.execPath,
      [join(packageNodeModulesDir(refuseUuid), "dist", "main.js"), "replace", "uuid", "--no-pr", "--budget-ms", "400", "--workers", "1"],
      refuseUuid,
    );
    assert.equal(uuidRefused.status, 3, `uuid v7\n${uuidRefused.stdout}\n${uuidRefused.stderr}`);
    assert.match(`${uuidRefused.stdout}\n${uuidRefused.stderr}`, /envelope-too-wide|v7/);
    assert.equal(existsSync(join(refuseUuid, "src/slim")), false);
    assert.equal(readFileSync(join(refuseUuid, "package.json"), "utf8"), beforeUuid);

    const refuseTemplate = join(tmp, "refuse-lodash-template");
    copyFixture("lodash-get-debounce", refuseTemplate);
    writeFileSync(
      join(refuseTemplate, "src/index.ts"),
      `import template from "lodash.template";
export const t = template("<%= a %>");
`,
    );
    writeFileSync(
      join(refuseTemplate, "src/index.test.ts"),
      `import { test } from "node:test";
import assert from "node:assert/strict";
import { t } from "./index.ts";
test("template", () => {
  assert.equal(typeof t, "function");
});
`,
    );
    setDeps(refuseTemplate, { "lodash.template": "4.18.1" }, ["lodash"]);
    npmInstall(refuseTemplate, tarball);
    const beforeTpl = readFileSync(join(refuseTemplate, "package.json"), "utf8");
    const tplRefused = run(
      process.execPath,
      [join(packageNodeModulesDir(refuseTemplate), "dist", "main.js"), "replace", "lodash.template", "--no-pr", "--budget-ms", "400", "--workers", "1"],
      refuseTemplate,
    );
    assert.equal(tplRefused.status, 3, `lodash.template\n${tplRefused.stdout}\n${tplRefused.stderr}`);
    assert.match(`${tplRefused.stdout}\n${tplRefused.stderr}`, /envelope-too-wide|template/);
    assert.equal(existsSync(join(refuseTemplate, "src/slim")), false);
    assert.equal(readFileSync(join(refuseTemplate, "package.json"), "utf8"), beforeTpl);
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(packDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
