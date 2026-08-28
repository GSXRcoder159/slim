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

test("action runner is committed JS and never falls back to source", async () => {
  const runner = readFileSync(join(ROOT, "action/run.mjs"), "utf8");
  const digestSrc = readFileSync(join(ROOT, "action/digest.mjs"), "utf8");
  assert.match(runner, /digest\.mjs/);
  assert.match(digestSrc, /dist\/github/);
  assert.doesNotMatch(runner, /experimental-strip-types/);
  assert.doesNotMatch(digestSrc, /experimental-strip-types/);
  assert.doesNotMatch(runner, /SLIM_REQUIRE_DIST/);
  assert.doesNotMatch(digestSrc, /SLIM_REQUIRE_DIST/);
  assert.ok(readdirSync(join(ROOT, "action")).includes("run.mjs"));
  assert.ok(readdirSync(join(ROOT, "action")).includes("digest.mjs"));

  const missing = spawnSync(process.execPath, [join(ROOT, "action/run.mjs")], {
    encoding: "utf8",
  });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /usage: run\.mjs/);

  const { actionManifest, STAMP_NAME } = await import("../action/digest.mjs");
  const tmp = mkdtempSync(join(tmpdir(), "slim-action-"));
  try {
    const yml = "name: stub\nruns:\n  using: composite\n  steps: []\n";
    for (const name of ["check", "bloat", "upstream"] as const) {
      mkdirSync(join(tmp, "action", name), { recursive: true });
      writeFileSync(join(tmp, "action", name, "action.yml"), yml);
    }
    writeFileSync(join(tmp, "action", "run.mjs"), runner);
    writeFileSync(join(tmp, "action", "digest.mjs"), digestSrc);
    const stub = (msg: string) => `process.stdout.write(${JSON.stringify(msg)} + "\\n");\n`;
    mkdirSync(join(tmp, "dist", "github"), { recursive: true });
    mkdirSync(join(tmp, "src", "github"), { recursive: true });
    writeFileSync(join(tmp, "dist", "github", "check-action.js"), stub("DIST"));
    writeFileSync(join(tmp, "src", "github", "check-action.ts"), stub("SRC"));
    const { sha256 } = actionManifest(tmp);
    writeFileSync(
      join(tmp, "dist", STAMP_NAME),
      `${JSON.stringify({ ok: true, actionSha256: sha256 })}\n`,
    );

    const both = spawnSync(process.execPath, [join(tmp, "action", "run.mjs"), "check"], {
      encoding: "utf8",
    });
    assert.equal(both.status, 0, both.stderr);
    assert.equal(both.stdout.trim(), "DIST");

    const pinOk = spawnSync(process.execPath, [join(tmp, "action", "run.mjs"), "check"], {
      encoding: "utf8",
      env: { ...process.env, SLIM_ACTION_DIGEST: sha256 },
    });
    assert.equal(pinOk.status, 0, pinOk.stderr);
    assert.equal(pinOk.stdout.trim(), "DIST");

    const pinBad = spawnSync(process.execPath, [join(tmp, "action", "run.mjs"), "check"], {
      encoding: "utf8",
      env: { ...process.env, SLIM_ACTION_DIGEST: "a".repeat(64) },
    });
    assert.equal(pinBad.status, 4);
    assert.match(pinBad.stderr, /action digest mismatch/);
    assert.notEqual(pinBad.stdout.trim(), "SRC");

    writeFileSync(
      join(tmp, "dist", STAMP_NAME),
      `${JSON.stringify({ ok: true, actionSha256: "b".repeat(64) })}\n`,
    );
    const stale = spawnSync(process.execPath, [join(tmp, "action", "run.mjs"), "check"], {
      encoding: "utf8",
    });
    assert.equal(stale.status, 4);
    assert.match(stale.stderr, /stale action distributable/);

    rmSync(join(tmp, "dist", STAMP_NAME), { force: true });
    const noStamp = spawnSync(process.execPath, [join(tmp, "action", "run.mjs"), "check"], {
      encoding: "utf8",
    });
    assert.equal(noStamp.status, 4);
    assert.match(noStamp.stderr, new RegExp(`missing dist/${STAMP_NAME}`));

    rmSync(join(tmp, "dist"), { recursive: true, force: true });
    const srcOnly = spawnSync(process.execPath, [join(tmp, "action", "run.mjs"), "check"], {
      encoding: "utf8",
    });
    assert.equal(srcOnly.status, 4);
    assert.match(srcOnly.stderr, /missing dist\/github\/check-action\.js/);
    assert.notEqual(srcOnly.stdout.trim(), "SRC");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
