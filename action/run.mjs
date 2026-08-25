#!/usr/bin/env node
/**
 * GitHub composite-action entry. Prefers compiled dist so packed installs
 * and CI-after-build match. Falls back to source only when dist is absent
 * (this repo before `npm run build`). Missing both is exit 4, not a skip.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const names = {
  check: "check-action",
  bloat: "bloat-action",
  upstream: "upstream-action",
};

const cmd = process.argv[2];
const extra = process.argv.slice(3);
const rel = names[cmd];
if (!rel) {
  process.stderr.write("usage: run.mjs <check|bloat|upstream>\n");
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist/github", `${rel}.js`);
const src = join(root, "src/github", `${rel}.ts`);

let argv;
if (existsSync(dist)) {
  argv = [dist, ...extra];
} else if (process.env.SLIM_REQUIRE_DIST) {
  process.stderr.write(
    `slim action ${cmd}: SLIM_REQUIRE_DIST=1 but missing dist/github/${rel}.js under ${root}\n`,
  );
  process.exit(4);
} else if (existsSync(src)) {
  argv = ["--experimental-strip-types", src, ...extra];
} else {
  process.stderr.write(
    `slim action ${cmd}: missing dist/github/${rel}.js and src/github/${rel}.ts under ${root}\n`,
  );
  process.exit(4);
}

const r = spawnSync(process.execPath, argv, { stdio: "inherit", env: process.env });
if (r.error) {
  process.stderr.write(String(r.error) + "\n");
  process.exit(1);
}
process.exit(r.status ?? 1);
