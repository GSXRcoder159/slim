import { createGen } from "./gen.ts";

function toUuid(bytes: Uint8Array): string {
  const b = bytes.slice(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  let hex = "";
  for (let i = 0; i < 16; i++) hex += (b[i] ?? 0).toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Install a seeded CSPRNG stand-in so orig and slim see the same stream.
 * Call twice with the same seed (once per side). Restores platform crypto on return.
 */
export function withSeededCrypto<T>(seed: number, fn: () => T): T {
  const cryptoObj = globalThis.crypto;
  const origGRV = cryptoObj.getRandomValues.bind(cryptoObj);
  const origUUID = cryptoObj.randomUUID.bind(cryptoObj);
  const gen = createGen(seed >>> 0);
  const fill = <TArr extends ArrayBufferView>(arr: TArr): TArr => {
    const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    for (let i = 0; i < u8.length; i++) u8[i] = gen.int(0, 255);
    return arr;
  };
  cryptoObj.getRandomValues = fill;
  cryptoObj.randomUUID = (() => toUuid(fill(new Uint8Array(16)))) as typeof origUUID;
  try {
    return fn();
  } finally {
    cryptoObj.getRandomValues = origGRV;
    cryptoObj.randomUUID = origUUID;
  }
}
