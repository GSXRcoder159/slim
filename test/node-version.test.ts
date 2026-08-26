import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIN_NODE_ENGINES,
  MIN_NODE_LABEL,
  MIN_NODE_MAJOR,
  MIN_NODE_MINOR,
  nodeMeetsMinimum,
} from "../src/node-min.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("nodeMeetsMinimum matches engines 22.18", () => {
  assert.equal(MIN_NODE_MAJOR, 22);
  assert.equal(MIN_NODE_MINOR, 18);
  assert.equal(nodeMeetsMinimum("22.18.0"), true);
  assert.equal(nodeMeetsMinimum("22.17.9"), false);
  assert.equal(nodeMeetsMinimum("20.12.0"), false);
  assert.equal(nodeMeetsMinimum("23.0.0"), true);
});

test("package, CI, Actions, README, and doctor name the same minimum Node", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    engines: { node: string };
  };
  assert.equal(pkg.engines.node, MIN_NODE_ENGINES);

  const doctor = readFileSync(join(ROOT, "src/doctor.ts"), "utf8");
  assert.match(doctor, /older than \$\{MIN_NODE_LABEL\}/);

  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.match(readme, />=22\.18/);

  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /node:\s*\["22\.18", "24"\]/);
  assert.match(ci, /node-version:\s*\$\{\{\s*matrix\.node\s*\}\}/);

  const release = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  assert.match(release, /node-version:\s*"22\.18"/);

  for (const name of ["check", "bloat", "upstream"] as const) {
    const yml = readFileSync(join(ROOT, "action", name, "action.yml"), "utf8");
    assert.match(yml, /Node >= 22\.18/);
    assert.match(yml, /node-version: '22\.18'/);
    assert.match(yml, /split\('\.'\)\[1\]/);
    assert.match(yml, /-lt 18/);
  }

  const repoDoc = readFileSync(join(ROOT, "docs/repo.md"), "utf8");
  assert.match(repoDoc, />=22\.18\.0/);
  assert.doesNotMatch(repoDoc, /20\.12/);
});

test("action runner is committed JS and prefers dist", () => {
  const runner = readFileSync(join(ROOT, "action/run.mjs"), "utf8");
  assert.match(runner, /dist\/github/);
  assert.match(runner, /experimental-strip-types/);
  assert.match(runner, /process\.exit\(4\)/);
  assert.ok(readdirSync(join(ROOT, "action")).includes("run.mjs"));

  const missing = spawnSync(process.execPath, [join(ROOT, "action/run.mjs")], {
    encoding: "utf8",
  });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /usage: run\.mjs/);

  const tmp = mkdtempSync(join(tmpdir(), "slim-action-"));
  try {
    mkdirSync(join(tmp, "action"), { recursive: true });
    writeFileSync(join(tmp, "action", "run.mjs"), runner);
    const stub = (msg: string) => `process.stdout.write(${JSON.stringify(msg)} + "\\n");\n`;
    mkdirSync(join(tmp, "dist", "github"), { recursive: true });
    mkdirSync(join(tmp, "src", "github"), { recursive: true });
    writeFileSync(join(tmp, "dist", "github", "check-action.js"), stub("DIST"));
    writeFileSync(join(tmp, "src", "github", "check-action.ts"), stub("SRC"));

    const both = spawnSync(process.execPath, [join(tmp, "action", "run.mjs"), "check"], {
      encoding: "utf8",
    });
    assert.equal(both.status, 0, both.stderr);
    assert.equal(both.stdout.trim(), "DIST");

    rmSync(join(tmp, "dist"), { recursive: true, force: true });
    const srcOnly = spawnSync(process.execPath, [join(tmp, "action", "run.mjs"), "check"], {
      encoding: "utf8",
    });
    assert.equal(srcOnly.status, 0, srcOnly.stderr);
    assert.equal(srcOnly.stdout.trim(), "SRC");

    const requireDist = spawnSync(process.execPath, [join(tmp, "action", "run.mjs"), "check"], {
      encoding: "utf8",
      env: { ...process.env, SLIM_REQUIRE_DIST: "1" },
    });
    assert.equal(requireDist.status, 4);
    assert.match(requireDist.stderr, /SLIM_REQUIRE_DIST/);
    assert.notEqual(requireDist.stdout.trim(), "SRC");

    rmSync(join(tmp, "src"), { recursive: true, force: true });
    const neither = spawnSync(process.execPath, [join(tmp, "action", "run.mjs"), "check"], {
      encoding: "utf8",
    });
    assert.equal(neither.status, 4);
    assert.match(neither.stderr, /missing dist\/github\/check-action\.js/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
