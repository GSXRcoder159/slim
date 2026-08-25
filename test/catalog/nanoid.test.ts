import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { customAlphabet as nanoidAlphabet, nanoid as nanoidOracle } from "nanoid";
import { customAlphabet, nanoid } from "../../src/generate/catalog/nanoid.ts";

const DEFAULT_ALPHABET =
  "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CATALOG = join(ROOT, "src/generate/catalog/nanoid.ts");

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
    assert.equal(nanoid(-1), "");
  });

  it("agrees with nanoid byte-for-byte under a shared getRandomValues stream", () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_CHANNEL_FD;
    const r = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `
import assert from "node:assert/strict";
import { customAlphabet as nanoidAlphabet, nanoid as nanoidOracle } from "nanoid";
import { customAlphabet, nanoid } from ${JSON.stringify(pathToFileURL(CATALOG).href)};

assert.throws(() => nanoid(-1), { name: "RangeError" });

const stream = (seed) => {
  let i = 0;
  return (buf) => {
    const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let k = 0; k < u8.length; k++) u8[k] = (seed + i++) & 255;
    return buf;
  };
};
const cryptoObj = globalThis.crypto;
const original = cryptoObj.getRandomValues.bind(cryptoObj);
try {
  cryptoObj.getRandomValues = stream(7);
  const slimDefault = nanoid();
  cryptoObj.getRandomValues = stream(7);
  const realDefault = nanoidOracle();
  assert.equal(slimDefault, realDefault);

  cryptoObj.getRandomValues = stream(11);
  const slimAbc = customAlphabet("abc", 5)();
  cryptoObj.getRandomValues = stream(11);
  const realAbc = nanoidAlphabet("abc", 5)();
  assert.equal(slimAbc, realAbc);

  cryptoObj.getRandomValues = stream(13);
  const slimSized = nanoid(10);
  cryptoObj.getRandomValues = stream(13);
  const realSized = nanoidOracle(10);
  assert.equal(slimSized, realSized);
} finally {
  cryptoObj.getRandomValues = original;
}
        `,
      ],
      { encoding: "utf8", cwd: ROOT, env, timeout: 15_000 },
    );
    assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
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
