/**
 * MIT License
 *
 * Original Slim implementation of the public clsx API (conditional className
 * strings). Not derived from the clsx package source.
 */

function append(input: unknown, out: string[]): void {
  if (!input && input !== 0) return;
  const kind = typeof input;
  if (kind === "string" || kind === "number") {
    if (input) out.push(String(input));
    return;
  }
  if (kind !== "object") return;
  if (Array.isArray(input)) {
    for (const item of input) append(item, out);
    return;
  }
  const obj = input as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (obj[key]) out.push(key);
  }
}

export function clsx(...inputs: unknown[]): string {
  const out: string[] = [];
  for (const input of inputs) append(input, out);
  return out.join(" ");
}

export default clsx;
