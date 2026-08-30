/**
 * Install a seeded CSPRNG stand-in so orig and slim see the same stream.
 * Patches `globalThis.crypto` and `node:crypto` (uuid's named `randomUUID`
 * import) then restores both. Call twice with the same seed (once per side).
 */
export declare function withSeededCrypto<T>(seed: number, fn: () => T): T;
