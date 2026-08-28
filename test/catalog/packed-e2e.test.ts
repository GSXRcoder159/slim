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
import { npmPackTo } from "../helpers/llm-replace.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = tmpdir();

const CASES: Array<{ dir: string; pkg: string; lodashInput?: boolean }> = [
  { dir: "lodash-get-debounce", pkg: "lodash", lodashInput: true },
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

function copyFixture(name: string, dest: string, lodashInput: boolean): void {
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
  if (lodashInput) {
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

function assertReplaceLoop(dest: string, pkg: string, slimJs: string): void {
  const replaced = run(
    process.execPath,
    [slimJs, "replace", pkg, "--no-pr", "--budget-ms", "800", "--workers", "1"],
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
  const evidence = JSON.parse(readFileSync(evidenceJson, "utf8")) as { fuzz?: { comparisons?: number } };
  assert.ok((evidence.fuzz?.comparisons ?? 0) > 0, `${pkg}: evidence.fuzz.comparisons`);
}

function npmInstall(cwd: string, tarball: string): void {
  execPm("npm", ["install", tarball], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: npmEnv(),
  });
}

test("packed CLI replace → standing tests → slim check for every registered catalog package and alias", { timeout: 1_200_000 }, () => {
  execPm("npm", ["run", "build"], { cwd: ROOT, encoding: "utf8", timeout: 60_000, env: npmEnv() });
  mkdirSync(TMP, { recursive: true });
  const packDir = mkdtempSync(join(TMP, "slim-catalog-pack-"));
  const tarball = npmPackTo(packDir);
  const tmp = mkdtempSync(join(TMP, "slim-catalog-e2e-"));
  try {
    for (const c of CASES) {
      const dest = join(tmp, c.dir);
      copyFixture(c.dir, dest, Boolean(c.lodashInput));
      npmInstall(dest, tarball);
      const slimJs = join(dest, "node_modules", "slim", "dist", "main.js");
      assert.ok(existsSync(slimJs), `${c.pkg}: installed slim CLI`);
      assertReplaceLoop(dest, c.pkg, slimJs);
    }

    const lodashEs = join(tmp, "alias-lodash-es");
    copyFixture("lodash-get-debounce", lodashEs, true);
    writeFileSync(
      join(lodashEs, "src/index.ts"),
      readFileSync(join(lodashEs, "src/index.ts"), "utf8").replaceAll('"lodash"', '"lodash-es"'),
    );
    setDeps(lodashEs, { "lodash-es": "4.17.21" }, ["lodash"]);
    npmInstall(lodashEs, tarball);
    assertReplaceLoop(lodashEs, "lodash-es", join(lodashEs, "node_modules", "slim", "dist", "main.js"));

    const underscore = join(tmp, "alias-underscore");
    copyFixture("lodash-get-debounce", underscore, false);
    writeFileSync(
      join(underscore, "src/index.ts"),
      `import _ from "underscore";

export function pickUser(user: { profile?: { name?: string | null } } | null): string {
  return _.get(user, ["profile", "name"], "anonymous") as string;
}
`,
    );
    writeFileSync(
      join(underscore, "src/index.test.ts"),
      `import { test } from "node:test";
import assert from "node:assert/strict";
import { pickUser } from "./index.ts";

test("get default only when undefined", () => {
  assert.equal(pickUser({ profile: { name: "Ada" } }), "Ada");
  assert.equal(pickUser({}), "anonymous");
});
`,
    );
    setDeps(underscore, { underscore: "npm:lodash@4.17.21" }, ["lodash"]);
    npmInstall(underscore, tarball);
    assertReplaceLoop(underscore, "underscore", join(underscore, "node_modules", "slim", "dist", "main.js"));

    const lodashGet = join(tmp, "alias-lodash-get");
    copyFixture("lodash-get-debounce", lodashGet, false);
    writeFileSync(
      join(lodashGet, "src/index.ts"),
      `import get from "lodash.get";

export function pickUser(user: { profile?: { name?: string | null } } | null): string {
  return get(user, "profile.name", "anonymous") as string;
}
`,
    );
    writeFileSync(
      join(lodashGet, "src/index.test.ts"),
      `import { test } from "node:test";
import assert from "node:assert/strict";
import { pickUser } from "./index.ts";

test("get default only when undefined", () => {
  assert.equal(pickUser({ profile: { name: "Ada" } }), "Ada");
  assert.equal(pickUser({}), "anonymous");
});
`,
    );
    setDeps(lodashGet, { "lodash.get": "4.4.2" }, ["lodash"]);
    npmInstall(lodashGet, tarball);
    assertReplaceLoop(lodashGet, "lodash.get", join(lodashGet, "node_modules", "slim", "dist", "main.js"));

    const classnames = join(tmp, "alias-classnames");
    copyFixture("clsx-join", classnames, false);
    writeFileSync(
      join(classnames, "src/index.ts"),
      `import classnames from "classnames";

export function classes(active: boolean): string {
  return classnames("btn", active ? "btn-active" : "", "px-2");
}
`,
    );
    setDeps(classnames, { classnames: "2.5.1" }, ["clsx"]);
    npmInstall(classnames, tarball);
    assertReplaceLoop(classnames, "classnames", join(classnames, "node_modules", "slim", "dist", "main.js"));

    const mime = join(tmp, "alias-mime");
    copyFixture("mime-types-lookup", mime, false);
    writeFileSync(
      join(mime, "src/index.ts"),
      `import { lookup } from "mime";

export function typeOf(path: string): string | false {
  return lookup(path);
}
`,
    );
    setDeps(mime, { mime: "npm:mime-types@2.1.35" }, ["mime-types"]);
    npmInstall(mime, tarball);
    assertReplaceLoop(mime, "mime", join(mime, "node_modules", "slim", "dist", "main.js"));

    const mimeDb = join(tmp, "alias-mime-db");
    copyFixture("mime-types-lookup", mimeDb, false);
    writeFileSync(
      join(mimeDb, "src/index.ts"),
      `import { lookup } from "mime-db";

export function typeOf(path: string): string | false {
  return lookup(path);
}
`,
    );
    setDeps(mimeDb, { "mime-db": "npm:mime-types@2.1.35" }, ["mime-types"]);
    npmInstall(mimeDb, tarball);
    assertReplaceLoop(mimeDb, "mime-db", join(mimeDb, "node_modules", "slim", "dist", "main.js"));

    const urlParse = join(tmp, "alias-url-parse");
    copyFixture("whatwg-url-host", urlParse, false);
    writeFileSync(
      join(urlParse, "src/index.ts"),
      `import { URL } from "url-parse";

export function host(href: string): string {
  return new URL(href).hostname;
}
`,
    );
    setDeps(urlParse, { "url-parse": "npm:whatwg-url@14.2.0" }, ["whatwg-url"]);
    npmInstall(urlParse, tarball);
    assertReplaceLoop(urlParse, "url-parse", join(urlParse, "node_modules", "slim", "dist", "main.js"));

    const refuseLodashEs = join(tmp, "refuse-lodash-es-template");
    copyFixture("lodash-get-debounce", refuseLodashEs, false);
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
    const slimRefuse = join(refuseLodashEs, "node_modules", "slim", "dist", "main.js");
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
    copyFixture("mime-types-lookup", refuseMime, false);
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
      [join(refuseMime, "node_modules", "slim", "dist", "main.js"), "replace", "mime", "--no-pr", "--budget-ms", "400", "--workers", "1"],
      refuseMime,
    );
    assert.equal(mimeRefused.status, 3, `mime contentType\n${mimeRefused.stdout}\n${mimeRefused.stderr}`);
    assert.match(`${mimeRefused.stdout}\n${mimeRefused.stderr}`, /envelope-too-wide|contentType/);
    assert.equal(existsSync(join(refuseMime, "src/slim")), false);
    assert.equal(readFileSync(join(refuseMime, "package.json"), "utf8"), beforeMime);

    const refuseUrl = join(tmp, "refuse-url-parse-parseURL");
    copyFixture("whatwg-url-host", refuseUrl, false);
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
      [join(refuseUrl, "node_modules", "slim", "dist", "main.js"), "replace", "url-parse", "--no-pr", "--budget-ms", "400", "--workers", "1"],
      refuseUrl,
    );
    assert.equal(urlRefused.status, 3, `url-parse parseURL\n${urlRefused.stdout}\n${urlRefused.stderr}`);
    assert.match(`${urlRefused.stdout}\n${urlRefused.stderr}`, /envelope-too-wide|parseURL/);
    assert.equal(existsSync(join(refuseUrl, "src/slim")), false);
    assert.equal(readFileSync(join(refuseUrl, "package.json"), "utf8"), beforeUrl);
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(packDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
