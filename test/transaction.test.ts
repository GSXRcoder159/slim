import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("prepareWrite creates parent directories", () => {
  const root = tmp();
  const f = join(root, "a", "b", "c.txt");
  const txn = new MutationTxn(root);
  txn.prepareWrite(f);
  writeFileSync(f, "ok");
  assert.equal(readFileSync(f, "utf8"), "ok");
  rmSync(root, { recursive: true, force: true });
});
