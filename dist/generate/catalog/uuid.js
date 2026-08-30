/**
 * MIT License
 *
 * Original Slim implementation of UUID v4 using the public RFC 4122 layout
 * and `crypto.randomUUID` when the caller does not supply bytes.
 * Not affiliated with the uuid package authors.
 */
function toHex(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 1) {
        out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
    }
    return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}
function parseUuid(id) {
    const hex = id.replace(/-/g, "");
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) {
        bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}
function setRfc4122V4Bits(bytes) {
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
}
function writeBuf(bytes, buf, offset) {
    if (offset < 0 || offset + 16 > buf.length) {
        throw new RangeError("uuid v4: buffer is too small for offset");
    }
    buf.set(bytes, offset);
}
export function v4(opts, buf, offset) {
    const at = offset ?? 0;
    if (opts?.random) {
        if (opts.random.length < 16) {
            throw new TypeError("uuid v4: random must contain at least 16 bytes");
        }
        const bytes = opts.random.length === 16 ? opts.random : opts.random.subarray(0, 16);
        setRfc4122V4Bits(bytes);
        if (buf)
            writeBuf(bytes, buf, at);
        return toHex(bytes);
    }
    const id = globalThis.crypto.randomUUID();
    if (buf)
        writeBuf(parseUuid(id), buf, at);
    return id;
}
//# sourceMappingURL=uuid.js.map