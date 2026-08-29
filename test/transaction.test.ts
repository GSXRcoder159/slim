import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EXIT_FAIL, EXIT_USAGE, SlimExit } from "../src/exit.ts";
import { MutationTxn } from "../src/rewrite/transaction.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "slim-txn-"));
}

test("rollback restores a mutated existing file", () => {
  const root = tmp();
  const f = join(root, "a.txt");
  writeFileSync(f, "orig");
  const txn = new MutationTxn(root);
  txn.prepareWrite(f);
  writeFileSync(f, "mutated");
  txn.rollback();
  assert.equal(readFileSync(f, "utf8"), "orig");
});

test("rollback deletes a file that did not exist", () => {
  const root = tmp();
  const f = join(root, "nested", "new.txt");
  const txn = new MutationTxn(root);
  txn.prepareWrite(f);
  writeFileSync(f, "created");
  txn.rollback();
  assert.equal(existsSync(f), false);
  assert.equal(existsSync(join(root, "nested")), false);
});

test("double snapshot keeps the first original", () => {
  const root = tmp();
  const f = join(root, "a.txt");
  writeFileSync(f, "orig");
  const txn = new MutationTxn(root);
  txn.prepareWrite(f);
  writeFileSync(f, "once");
  txn.prepareWrite(f);
  writeFileSync(f, "twice");
  txn.rollback();
  assert.equal(readFileSync(f, "utf8"), "orig");
});

test("commit then rollback is a no-op", () => {
  const root = tmp();
  const f = join(root, "a.txt");
  writeFileSync(f, "orig");
  const txn = new MutationTxn(root);
  txn.prepareWrite(f);
  writeFileSync(f, "mutated");
  txn.commit();
  txn.rollback();
  assert.equal(readFileSync(f, "utf8"), "mutated");
});

test("rollback restores binary bytes", () => {
  const root = tmp();
  const f = join(root, "b.bin");
  writeFileSync(f, Buffer.from([0, 1, 255]));
  const txn = new MutationTxn(root);
  txn.prepareWrite(f);
  writeFileSync(f, Buffer.from([9, 9]));
  txn.rollback();
  assert.deepEqual(readFileSync(f), Buffer.from([0, 1, 255]));
});

test("rollback removes empty dirs created for nested writes", () => {
  const root = tmp();
  mkdirSync(join(root, "keep"), { recursive: true });
  writeFileSync(join(root, "keep", "x.txt"), "x");
  const f = join(root, "keep", "new", "y.txt");
  const txn = new MutationTxn(root);
  txn.prepareWrite(f);
  writeFileSync(f, "y");
  txn.rollback();
  assert.equal(existsSync(f), false);
  assert.equal(existsSync(join(root, "keep", "new")), false);
  assert.equal(readFileSync(join(root, "keep", "x.txt"), "utf8"), "x");
});

test("mutatedPaths lists project-relative files before commit", () => {
  const root = tmp();
  const f = join(root, "src", "slim", "lodash.ts");
  const txn = new MutationTxn(root);
  txn.writeFile(f, "export {}\n");
  txn.prepareWrite(join(root, ".slim", "lodash", "evidence.md"));
  writeFileSync(join(root, ".slim", "lodash", "evidence.md"), "md");
  assert.deepEqual(txn.mutatedPaths().sort(), [".slim/lodash/evidence.md", "src/slim/lodash.ts"]);
  txn.commit();
  assert.deepEqual(txn.mutatedPaths(), []);
});

test("prepareWrite creates parent directories", () => {
  const root = tmp();
  const f = join(root, "a", "b", "c.txt");
  const txn = new MutationTxn(root);
  txn.prepareWrite(f);
  writeFileSync(f, "ok");
  assert.equal(readFileSync(f, "utf8"), "ok");
  rmSync(root, { recursive: true, force: true });
});

test("write through an internal symlink is refused and leaves both sides unchanged", () => {
  const root = tmp();
  const real = join(root, "real.txt");
  const link = join(root, "link.txt");
  writeFileSync(real, "orig");
  symlinkSync("real.txt", link);
  const txn = new MutationTxn(root);
  assert.throws(
    () => txn.writeFile(link, "mutated"),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_USAGE && /is a symlink/i.test(e.message),
  );
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readlinkSync(link), "real.txt");
  assert.equal(readFileSync(real, "utf8"), "orig");
});

test("rollback restores an internal symlink snapshotted without write-through", () => {
  const root = tmp();
  const real = join(root, "real.txt");
  const link = join(root, "link.txt");
  writeFileSync(real, "orig");
  symlinkSync("real.txt", link);
  const txn = new MutationTxn(root);
  txn.snapshot(link);
  rmSync(link);
  writeFileSync(link, "now a file");
  txn.rollback();
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readlinkSync(link), "real.txt");
  assert.equal(readFileSync(real, "utf8"), "orig");
});

test("write into a path whose parent is an internal symlink is refused", () => {
  const root = tmp();
  const destDir = join(root, "elsewhere");
  mkdirSync(destDir);
  writeFileSync(join(destDir, "keep.txt"), "keep\n");
  symlinkSync("elsewhere", join(root, "out"));
  const txn = new MutationTxn(root);
  assert.throws(
    () => txn.writeFile(join(root, "out", "ms.ts"), "hacked\n"),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_USAGE && /is a symlink/i.test(e.message),
  );
  assert.equal(lstatSync(join(root, "out")).isSymbolicLink(), true);
  assert.equal(readFileSync(join(destDir, "keep.txt"), "utf8"), "keep\n");
  assert.equal(existsSync(join(destDir, "ms.ts")), false);
});

test("rollback restores a dangling symlink instead of leaving a regular file", () => {
  const root = tmp();
  const link = join(root, "link.txt");
  symlinkSync("gone.txt", link);
  const txn = new MutationTxn(root);
  txn.snapshot(link);
  rmSync(link);
  writeFileSync(link, "now a file");
  txn.rollback();
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readlinkSync(link), "gone.txt");
});

test("write through an escaping symlink is refused and leaves both sides unchanged", () => {
  const root = tmp();
  const outside = mkdtempSync(join(tmpdir(), "slim-txn-out-"));
  const secret = join(outside, "secret.txt");
  writeFileSync(secret, "keep");
  const link = join(root, "link.txt");
  symlinkSync(secret, link);
  const txn = new MutationTxn(root);
  assert.throws(
    () => txn.writeFile(link, "hacked"),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_USAGE && /escapes the project/i.test(e.message),
  );
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readFileSync(secret, "utf8"), "keep");
  rmSync(outside, { recursive: true, force: true });
});

test("rollback restores execute bits on posix", { skip: process.platform === "win32" }, () => {
  const root = tmp();
  const f = join(root, "run.sh");
  writeFileSync(f, "#!/bin/sh\n");
  chmodSync(f, 0o755);
  const before = lstatSync(f).mode & 0o777;
  const txn = new MutationTxn(root);
  txn.writeFile(f, "#!/bin/sh\necho x\n");
  txn.rollback();
  assert.equal(lstatSync(f).mode & 0o777, before);
});

test("write to a fifo is refused before mutation", { skip: process.platform === "win32" }, () => {
  const root = tmp();
  const fifo = join(root, "pipe");
  const mk = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  if (mk.status !== 0) throw new Error(`mkfifo failed: ${mk.stderr}`);
  const txn = new MutationTxn(root);
  assert.throws(
    () => txn.writeFile(fifo, "nope"),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_FAIL && /special file/i.test(e.message),
  );
  assert.equal(lstatSync(fifo).isFIFO(), true);
});
