/**
 * MIT License
 *
 * Original Slim implementation of the public `ms` duration API (parse one
 * duration token, format a millisecond count). Not derived from vercel/ms
 * source. Compound strings such as "1h 30m" are not valid inputs.
 */

const S = 1000;
const M = S * 60;
const H = M * 60;
const D = H * 24;
const W = D * 7;
const Y = D * 365.25;

const UNIT: Record<string, number> = {
  years: Y,
  year: Y,
  yrs: Y,
  yr: Y,
  y: Y,
  weeks: W,
  week: W,
  w: W,
  days: D,
  day: D,
  d: D,
  hours: H,
  hour: H,
  hrs: H,
  hr: H,
  h: H,
  minutes: M,
  minute: M,
  mins: M,
  min: M,
  m: M,
  seconds: S,
  second: S,
  secs: S,
  sec: S,
  s: S,
  milliseconds: 1,
  millisecond: 1,
  msecs: 1,
  msec: 1,
  ms: 1,
};

const PARSE =
  /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i;

export interface MsOptions {
  long?: boolean;
}

function badValue(val: unknown): never {
  throw new Error(
    `val is not a non-empty string or a valid number. val=${JSON.stringify(val)}`,
  );
}

function parse(str: string): number | undefined {
  if (str.length > 100) return undefined;
  const match = PARSE.exec(str);
  if (!match) return undefined;
  const n = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(n)) return undefined;
  const unit = (match[2] || "ms").toLowerCase();
  return n * (UNIT[unit] ?? 1);
}

function plural(msVal: number, unit: number, name: string): string {
  const abs = Math.abs(msVal);
  const n = Math.round(msVal / unit);
  return `${n} ${name}${abs >= unit * 1.5 ? "s" : ""}`;
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
