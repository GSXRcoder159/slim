import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

function run(
  bin: string,
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs = 180_000,
): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, CI: "1" };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  const r = spawnSync(bin, args, { cwd, encoding: "utf8", env, timeout: timeoutMs });
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
}

test("packed CLI replace → standing tests → slim check for every registered catalog package", { timeout: 720_000 }, () => {
  if (!existsSync(join(ROOT, "dist", ".slim-build.json"))) {
    execFileSync("npm", ["run", "build"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  }
  mkdirSync(TMP, { recursive: true });
  const packDir = mkdtempSync(join(TMP, "slim-catalog-pack-"));
  const tgz = execFileSync(
    "npm",
    ["pack", "--silent", "--ignore-scripts", `--pack-destination=${packDir}`],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
    },
  ).trim();
  const tarball = join(packDir, tgz.split("\n").pop() ?? tgz);
  const tmp = mkdtempSync(join(TMP, "slim-catalog-e2e-"));
  try {
    for (const c of CASES) {
      const dest = join(tmp, c.dir);
      copyFixture(c.dir, dest, Boolean(c.lodashInput));
      execFileSync("npm", ["install", tarball], {
        cwd: dest,
        encoding: "utf8",
        timeout: 120_000,
      });
      const slimJs = join(dest, "node_modules", "slim", "dist", "main.js");
      assert.ok(existsSync(slimJs), `${c.pkg}: installed slim CLI`);
      const replaced = run(
        process.execPath,
        [slimJs, "replace", c.pkg, "--no-pr", "--budget-ms", "800", "--workers", "1"],
        dest,
      );
      assert.equal(
        replaced.status,
        0,
        `${c.pkg} replace failed\nstdout:\n${replaced.stdout}\nstderr:\n${replaced.stderr}`,
      );
      const stem = c.pkg.replace(/\//g, "-");
      const slimMod = join(dest, "src", "slim", `${stem}.ts`);
      assert.ok(existsSync(slimMod), `${c.pkg}: missing generated slice`);
      const slice = readFileSync(slimMod, "utf8");
      assert.doesNotMatch(slice, new RegExp(`from ['"]${c.pkg}['"]`));
      const pkgJson = JSON.parse(readFileSync(join(dest, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      assert.equal(pkgJson.dependencies?.[c.pkg], undefined, `${c.pkg} still in package.json`);
      const standing = join(dest, "src", "slim", `${stem}.test.ts`);
      assert.ok(existsSync(standing), `${c.pkg}: missing standing tests`);
      const stood = run(
        process.execPath,
        ["--experimental-strip-types", "--test", standing],
        dest,
      );
      assert.equal(
        stood.status,
        0,
        `${c.pkg} standing tests failed\nstdout:\n${stood.stdout}\nstderr:\n${stood.stderr}`,
      );
      const checked = run(process.execPath, [slimJs, "check"], dest);
      assert.equal(
        checked.status,
        0,
        `${c.pkg} check failed\nstdout:\n${checked.stdout}\nstderr:\n${checked.stderr}`,
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(packDir, { recursive: true, force: true });
  }
});
