import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { v4 } from "../../src/generate/catalog/uuid.ts";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuid v4", () => {
  it("returns an RFC 4122 version-4 UUID via crypto.randomUUID", () => {
    const id = v4();
    assert.match(id, UUID_V4);
    assert.notEqual(v4(), v4());
  });

  it("looks up crypto.randomUUID at call time", () => {
    const cryptoObj = globalThis.crypto;
    const original = cryptoObj.randomUUID.bind(cryptoObj);
    let calls = 0;
    cryptoObj.randomUUID = () => {
      calls += 1;
      return "00000000-0000-4000-8000-000000000000";
    };
    try {
      assert.equal(v4(), "00000000-0000-4000-8000-000000000000");
      assert.equal(calls, 1);
    } finally {
      cryptoObj.randomUUID = original;
    }
  });

  it("formats provided random bytes as UUID v4 (version and variant bits)", () => {
    const random = new Uint8Array(16);
    const id = v4({ random });
    assert.equal(id, "00000000-0000-4000-8000-000000000000");
    assert.equal(random[6] & 0xf0, 0x40);
    assert.equal(random[8] & 0xc0, 0x80);
  });

  it("writes into a buffer at the given offset and still returns a string", () => {
    const random = Uint8Array.from({ length: 16 }, (_, i) => i);
    const buf = new Uint8Array(20);
    const id = v4({ random }, buf, 2);
    assert.match(id, UUID_V4);
    assert.equal(buf[2 + 6] & 0xf0, 0x40);
    assert.equal(buf[2 + 8] & 0xc0, 0x80);
    assert.equal(id, bytesToUuid(buf.subarray(2, 18)));
  });

  it("throws when random is shorter than 16 bytes", () => {
    assert.throws(() => v4({ random: new Uint8Array(8) }), { name: "TypeError" });
  });
});

function bytesToUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
