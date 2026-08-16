/**
 * MIT License
 *
 * Original Slim implementation of the public nanoid / customAlphabet API.
 * Uses `crypto.getRandomValues` looked up at call time. Not derived from
 * the nanoid package source.
 */

const DEFAULT_SIZE = 21;
const URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

function fill(alphabet: string, size: number): string {
  if (!Number.isInteger(size) || size < 0) {
    throw new Error("nanoid: size must be a non-negative integer");
  }
  if (alphabet.length === 0) {
    throw new Error("nanoid: alphabet must not be empty");
  }
  if (size === 0) return "";

  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  const alphaLen = alphabet.length;
  const limit = 256 - (256 % alphaLen);
  let id = "";
  while (id.length < size) {
    const need = size - id.length;
    const bytes = getRandomValues(new Uint8Array(need));
    for (let i = 0; i < bytes.length && id.length < size; i += 1) {
      const b = bytes[i];
      if (b === undefined || b >= limit) continue;
      id += alphabet[b % alphaLen];
    }
  }
  return id;
}

export function nanoid(size: number = DEFAULT_SIZE): string {
  return fill(URL_ALPHABET, size);
}

export function customAlphabet(
  alphabet: string,
  defaultSize: number = DEFAULT_SIZE,
): (size?: number) => string {
  return function customNanoid(size: number = defaultSize): string {
    return fill(alphabet, size);
  };
}
