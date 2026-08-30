/**
 * MIT License
 *
 * Original Slim implementation of the public clsx API (conditional className
 * strings). Not affiliated with the clsx package authors.
 */
function append(input, out) {
    if (!input && input !== 0)
        return;
    const kind = typeof input;
    if (kind === "string" || kind === "number") {
        if (input)
            out.push(String(input));
        return;
    }
    if (kind !== "object")
        return;
    if (Array.isArray(input)) {
        for (const item of input)
            append(item, out);
        return;
    }
    const obj = input;
    for (const key of Object.keys(obj)) {
        if (obj[key])
            out.push(key);
    }
}
export function clsx(...inputs) {
    const out = [];
    for (const input of inputs)
        append(input, out);
    return out.join(" ");
}
export default clsx;
//# sourceMappingURL=clsx.js.map