import { test } from "node:test";
import assert from "node:assert/strict";
import { collectDoctor, doctorExitCode, runDoctor } from "../src/doctor.ts";
import { parseCli } from "../src/cli.ts";
import { EXIT_ENV, EXIT_OK } from "../src/exit.ts";

const CJS_HOOKS_LINE =
  "cjs hooks      recommend Node >= 22.22.3 (documented CJS sync-hook fixes)";

async function captureDoctor(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await runDoctor(parseCli(argv));
    return { code, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

test("doctor sees this Node as ok", () => {
  const r = collectDoctor();
  assert.equal(r.nodeOk, true);
  assert.equal(r.registerHooks, true);
  assert.equal(r.node, process.versions.node);
});

test("doctor lists a dirty tree without failing by default", () => {
  const r = collectDoctor(process.cwd(), { porcelain: " M src/doctor.ts\n" });
  assert.equal(r.dirtyTree, true);
  assert.ok(r.issues.some((i) => /dirty/i.test(i)));
  assert.equal(doctorExitCode(r, false), EXIT_OK);
});

test("doctor --strict fails on a dirty tree", () => {
  const dirty = collectDoctor(process.cwd(), { porcelain: " M src/doctor.ts\n" });
  const clean = collectDoctor(process.cwd(), { porcelain: "" });
  assert.equal(dirty.dirtyTree, true);
  assert.equal(clean.dirtyTree, false);
  assert.ok(!clean.issues.some((i) => /dirty/i.test(i)));
  assert.equal(doctorExitCode(dirty, true), EXIT_ENV);
  assert.equal(doctorExitCode(clean, true), EXIT_OK);
});

test("doctor always prints the CJS hooks recommendation", async () => {
  const { code, stdout } = await captureDoctor(["doctor"]);
  assert.equal(code, EXIT_OK);
  assert.ok(stdout.includes(CJS_HOOKS_LINE), stdout);
});
