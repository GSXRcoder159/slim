import { clone } from "./clone.ts";
import { wallMs } from "./clock.ts";

/**
 * Delta-debug a disagreeing argument list. `pred` is true while the pair still
 * disagrees. Stops at `deadlineMs` (caller typically passes 2000).
 */
export function minimize(
  args: unknown[],
  pred: (a: unknown[]) => boolean,
  deadlineMs: number,
): unknown[] {
  const start = wallMs();
  const timedOut = (): boolean => wallMs() - start >= deadlineMs;
  let current = clone(args) as unknown[];
  if (!pred(current)) return current;

  while (current.length > 0 && !timedOut()) {
    const next = current.slice(0, -1);
    if (pred(next)) current = next;
    else break;
  }

  for (let i = 0; i < current.length && !timedOut(); i++) {
    current[i] = shrinkValue(current[i], (v) => {
      if (timedOut()) return false;
      const trial = current.slice();
      trial[i] = v;
      return pred(trial);
    });
  }

  for (let i = 0; i < current.length && !timedOut(); i++) {
    const trial = current.slice();
    trial[i] = null;
    if (pred(trial)) current = trial;
  }

  return current;
}

function shrinkValue(value: unknown, still: (v: unknown) => boolean): unknown {
  if (typeof value === "string" && value.length > 0) {
    let s = value;
    while (s.length > 1) {
      const half = s.slice(0, Math.ceil(s.length / 2));
      if (half !== s && still(half)) s = half;
      else break;
    }
    if (s.length && still("")) return "";
    return s;
  }
  if (Array.isArray(value)) {
    let a = value.slice();
    while (a.length) {
      const next = a.slice(0, -1);
      if (still(next)) a = next;
      else break;
    }
    if (a.length && still([])) return [];
    return a;
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const o = { ...(value as Record<string, unknown>) };
    const keys = Object.keys(o);
    for (const k of keys) {
      const trial = { ...o };
      delete trial[k];
      if (still(trial)) {
        delete o[k];
      }
    }
    if (Object.keys(o).length && still({})) return {};
    return o;
  }
  if (typeof value === "number" && value !== 0 && still(0)) return 0;
  return value;
}
