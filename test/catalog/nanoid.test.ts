import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { customAlphabet as nanoidAlphabet, nanoid as nanoidOracle } from "nanoid";
import { customAlphabet, nanoid } from "../../src/generate/catalog/nanoid.ts";

const DEFAULT_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

describe("nanoid", () => {
  it("returns 21 URL-safe characters by default", () => {
    const id = nanoid();
    assert.equal(id.length, 21);
    for (const ch of id) {
      assert.ok(DEFAULT_ALPHABET.includes(ch), `unexpected char ${ch}`);
    }
    assert.notEqual(nanoid(), nanoid());
  });

  it("honors a custom size", () => {
    assert.equal(nanoid(10).length, 10);
    assert.equal(nanoid(0), "");
  });

  it("looks up crypto.getRandomValues at call time", () => {
    const cryptoObj = globalThis.crypto;
    const original = cryptoObj.getRandomValues.bind(cryptoObj);
    let calls = 0;
    cryptoObj.getRandomValues = <T extends ArrayBufferView>(buf: T): T => {
      calls += 1;
      return original(buf);
    };
    try {
      nanoid(8);
      assert.ok(calls >= 1);
    } finally {
      cryptoObj.getRandomValues = original;
    }
  });

  it("customAlphabet uses the given alphabet and default size", () => {
    const abc = customAlphabet("abc", 5);
    const id = abc();
    assert.equal(id.length, 5);
    for (const ch of id) assert.ok("abc".includes(ch));
    assert.equal(abc(3).length, 3);
  });

  it("throws on an empty alphabet or negative size", () => {
    assert.throws(() => customAlphabet("", 4)(), { name: "Error" });
    assert.throws(() => nanoid(-1), { name: "Error" });
  });

  it("agrees with nanoid on public size/alphabet and injectable getRandomValues", () => {
    const slimId = nanoid();
    const realId = nanoidOracle();
    assert.equal(slimId.length, 21);
    assert.equal(realId.length, 21);
    for (const ch of slimId + realId) {
      assert.ok(DEFAULT_ALPHABET.includes(ch), `unexpected char ${ch}`);
    }
    assert.equal(nanoid(10).length, nanoidOracle(10).length);
    const slimAbc = customAlphabet("abc", 5)();
    const realAbc = nanoidAlphabet("abc", 5)();
    assert.equal(slimAbc.length, 5);
    assert.equal(realAbc.length, 5);
    for (const ch of slimAbc) assert.ok("abc".includes(ch));
    for (const ch of realAbc) assert.ok("abc".includes(ch));

    const cryptoObj = globalThis.crypto;
    const original = cryptoObj.getRandomValues.bind(cryptoObj);
    let calls = 0;
    cryptoObj.getRandomValues = <T extends ArrayBufferView>(buf: T): T => {
      calls += 1;
      return original(buf);
    };
    try {
      nanoid(6);
      assert.ok(calls >= 1, "catalog nanoid must look up getRandomValues at call time");
    } finally {
      cryptoObj.getRandomValues = original;
    }
  });
});
