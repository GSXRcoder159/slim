/**
 * MIT License
 *
 * Original Slim implementation of the public `ms` duration API.
 * Not derived from vercel/ms source. Includes a 100-character parse cap
 * (the documented ReDoS mitigation) and compound strings such as "1h 30m".
 */

const S = 1000;
const M = S * 60;
const H = M * 60;
const D = H * 24;
const W = D * 7;
const Y = D * 365.25;

const UNIT_TO_MS: Record<string, number> = {
  year: Y,
  years: Y,
  yrs: Y,
  yr: Y,
  y: Y,
  week: W,
  weeks: W,
  w: W,
  day: D,
  days: D,
  d: D,
  hour: H,
  hours: H,
  hrs: H,
  hr: H,
  h: H,
  minute: M,
  minutes: M,
  mins: M,
  min: M,
  m: M,
  second: S,
  seconds: S,
  secs: S,
  sec: S,
  s: S,
  millisecond: 1,
  milliseconds: 1,
  msecs: 1,
  msec: 1,
  ms: 1,
};

const UNIT_NAMES = Object.keys(UNIT_TO_MS).sort((a, b) => b.length - a.length);

export interface MsOptions {
  long?: boolean;
}

function badValue(val: unknown): never {
  throw new Error(
    `ms(): value must be a non-empty string or a finite number (got ${String(val)})`,
  );
}

function matchUnit(input: string, pos: number): string | null {
  const rest = input.slice(pos).toLowerCase();
  for (const name of UNIT_NAMES) {
    if (!rest.startsWith(name)) continue;
    const next = rest[name.length];
    if (next === undefined || next === " " || /[0-9.+-]/.test(next)) return name;
  }
  return null;
}

function parse(str: string): number | undefined {
  if (str.length > 100) {
    throw new Error("ms(): value exceeds 100 characters");
  }
  const input = str.trim();
  if (!input) return undefined;

  let pos = 0;
  let total = 0;
  let saw = false;
  while (pos < input.length) {
    while (input[pos] === " ") pos += 1;
    if (pos >= input.length) break;
    const num = /^-?(?:\d+\.?\d*|\.\d+)/.exec(input.slice(pos));
    if (!num) return undefined;
    const n = Number.parseFloat(num[0]);
    if (!Number.isFinite(n)) return undefined;
    pos += num[0].length;
    while (input[pos] === " ") pos += 1;
    const unit = matchUnit(input, pos);
    if (unit) pos += unit.length;
    total += n * (unit ? (UNIT_TO_MS[unit] ?? 1) : 1);
    saw = true;
  }
  return saw ? total : undefined;
}

function plural(msVal: number, unit: number, name: string): string {
  const n = Math.round(msVal / unit);
  return `${n} ${name}${Math.abs(n) === 1 ? "" : "s"}`;
}

function format(msVal: number, long: boolean): string {
  const abs = Math.abs(msVal);
  if (long) {
    if (abs >= D) return plural(msVal, D, "day");
    if (abs >= H) return plural(msVal, H, "hour");
    if (abs >= M) return plural(msVal, M, "minute");
    if (abs >= S) return plural(msVal, S, "second");
    return `${msVal} ms`;
  }
  if (abs >= D) return `${Math.round(msVal / D)}d`;
  if (abs >= H) return `${Math.round(msVal / H)}h`;
  if (abs >= M) return `${Math.round(msVal / M)}m`;
  if (abs >= S) return `${Math.round(msVal / S)}s`;
  return `${msVal}ms`;
}

export function ms(val: string): number | undefined;
export function ms(val: number, options?: MsOptions): string;
export function ms(val: string | number, options?: MsOptions): string | number | undefined {
  if (typeof val === "string" && val.length > 0) return parse(val);
  if (typeof val === "number" && Number.isFinite(val)) {
    return format(val, Boolean(options?.long));
  }
  badValue(val);
}

export default ms;
