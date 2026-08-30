import { createRequire } from "node:module";
import module from "node:module";
import { createGen } from "./gen.js";
const require = createRequire(import.meta.url);
function toUuid(bytes) {
    const b = bytes.slice(0, 16);
    b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
    b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
    let hex = "";
    for (let i = 0; i < 16; i++)
        hex += (b[i] ?? 0).toString(16).padStart(2, "0");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/**
 * Install a seeded CSPRNG stand-in so orig and slim see the same stream.
 * Patches `globalThis.crypto` and `node:crypto` (uuid's named `randomUUID`
 * import) then restores both. Call twice with the same seed (once per side).
 */
export function withSeededCrypto(seed, fn) {
    const cryptoObj = globalThis.crypto;
    const origGRV = cryptoObj.getRandomValues.bind(cryptoObj);
    const origUUID = cryptoObj.randomUUID.bind(cryptoObj);
    const nodeCrypto = require("node:crypto");
    const origNodeUUID = nodeCrypto.randomUUID;
    const origFillSync = nodeCrypto.randomFillSync;
    const gen = createGen(seed >>> 0);
    const fill = (arr) => {
        const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
        for (let i = 0; i < u8.length; i++)
            u8[i] = gen.int(0, 255);
        return arr;
    };
    const seededUUID = (() => toUuid(fill(new Uint8Array(16))));
    cryptoObj.getRandomValues = fill;
    cryptoObj.randomUUID = seededUUID;
    nodeCrypto.randomUUID = seededUUID;
    nodeCrypto.randomFillSync = ((buf, offset, size) => {
        const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        const start = offset ?? 0;
        const n = size ?? u8.length - start;
        fill(u8.subarray(start, start + n));
        return buf;
    });
    module.syncBuiltinESMExports();
    try {
        return fn();
    }
    finally {
        cryptoObj.getRandomValues = origGRV;
        cryptoObj.randomUUID = origUUID;
        nodeCrypto.randomUUID = origNodeUUID;
        nodeCrypto.randomFillSync = origFillSync;
        module.syncBuiltinESMExports();
    }
}
//# sourceMappingURL=crypto.js.map