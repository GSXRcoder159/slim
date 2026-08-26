/**
 * MIT License
 *
 * Original Slim implementation of the public nanoid / customAlphabet API.
 * Uses `crypto.getRandomValues` looked up at call time. Not affiliated with
 * the nanoid package authors.
 */

const DEFAULT_SIZE = 21;
const URL_ALPHABET =
  "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

let bytes: Uint8Array | undefined;
let cursor = 0;

function take(n: number): Uint8Array {
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  getRandomValues(new Uint8Array(0));
  const need = n | 0;
  if (!bytes || bytes.length < need) {
    bytes = getRandomValues(new Uint8Array(need << 7));
    cursor = 0;
  } else if (cursor + need > bytes.length) {
    getRandomValues(bytes);
    cursor = 0;
  }
  cursor += need;
  return bytes.subarray(cursor - need, cursor);
}

function fillUrl(size: number): string {
  const buf = take(size);
  let id = "";
  for (let i = 0; i < size; i++) {
    id += URL_ALPHABET[(buf[i] ?? 0) & 63];
  }
  return id;
}

function fillCustom(alphabet: string, size: number): string {
  const len = alphabet.length;
  const mask = (2 << (31 - Math.clz32((len - 1) | 1))) - 1;
  const step = Math.ceil((1.6 * mask * size) / len);
  let id = "";
  while (true) {
    const buf = take(step);
    let i = step;
    while (i--) {
      const ch = alphabet[(buf[i] ?? 0) & mask];
      if (!ch) continue;
      id += ch;
      if (id.length >= size) return id;
    }
  }
}

export function nanoid(size: number = DEFAULT_SIZE): string {
  const n = size | 0;
  if (n < 0) {
    if (bytes) {
      cursor += n;
      return "";
    }
    throw new RangeError(
      `The value of "size" is out of range. It must be >= 0 && <= 9007199254740991. Received ${n << 7}`,
    );
  }
  if (n === 0) return "";
  return fillUrl(n);
}

export function customAlphabet(
  alphabet: string,
  defaultSize: number = DEFAULT_SIZE,
): (size?: number) => string {
  if (alphabet.length === 0) {
    throw new Error("nanoid: alphabet must not be empty");
  }
  const fallback = defaultSize | 0;
  return function customNanoid(size: number = fallback): string {
    const n = size | 0;
    if (n < 0) {
      if (bytes) {
        cursor += n;
        return "";
      }
      throw new RangeError(
        `The value of "size" is out of range. It must be >= 0 && <= 9007199254740991. Received ${n << 7}`,
      );
    }
    if (n === 0) return "";
    return fillCustom(alphabet, n);
  };
}
