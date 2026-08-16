import type { FakeClock } from "./clock.ts";

export type DebounceOp =
  | { t: number; op: "call"; thisArg?: unknown; args: unknown[] }
  | { t: number; op: "cancel" }
  | { t: number; op: "flush" };

export interface DebounceScript {
  wait: number;
  options?: { leading?: boolean; trailing?: boolean; maxWait?: number };
  events: DebounceOp[];
  /** When true, the inner spy throws on each invocation. */
  throwing?: boolean;
}

export interface SpyEvent {
  t: number;
  thisArg: unknown;
  args: unknown[];
  threw?: { name: string; message: string };
}

export const TAXONOMY: Record<string, DebounceScript> = {
  "trailing-single": {
    wait: 32,
    events: [{ t: 0, op: "call", args: ["a"] }],
  },
  "trailing-burst": {
    wait: 32,
    events: [
      { t: 0, op: "call", args: ["first"] },
      { t: 10, op: "call", args: ["mid"] },
      { t: 20, op: "call", args: ["last"] },
    ],
  },
  "leading-only": {
    wait: 32,
    options: { leading: true, trailing: false },
    events: [
      { t: 0, op: "call", args: ["L"] },
      { t: 10, op: "call", args: ["ignored"] },
    ],
  },
  "leading-trailing-one": {
    wait: 32,
    options: { leading: true, trailing: true },
    events: [{ t: 0, op: "call", args: ["once"] }],
  },
  "leading-trailing-two": {
    wait: 32,
    options: { leading: true, trailing: true },
    events: [
      { t: 0, op: "call", args: ["lead"] },
      { t: 10, op: "call", args: ["trail"] },
    ],
  },
  "maxWait-stream": {
    wait: 32,
    options: { maxWait: 64 },
    events: [
      { t: 0, op: "call", args: [0] },
      { t: 16, op: "call", args: [16] },
      { t: 32, op: "call", args: [32] },
      { t: 48, op: "call", args: [48] },
      { t: 60, op: "call", args: [60] },
    ],
  },
  "cancel-mid": {
    wait: 32,
    events: [
      { t: 0, op: "call", args: ["nope"] },
      { t: 10, op: "cancel" },
    ],
  },
  "flush-mid": {
    wait: 32,
    events: [
      { t: 0, op: "call", args: ["flush-me"] },
      { t: 10, op: "flush" },
    ],
  },
  "flush-empty": {
    wait: 32,
    events: [{ t: 0, op: "flush" }],
  },
  "wait-zero": {
    wait: 0,
    events: [{ t: 0, op: "call", args: ["z"] }],
  },
  "this-and-args": {
    wait: 32,
    events: [{ t: 0, op: "call", thisArg: { id: 7 }, args: ["x", 2] }],
  },
  "return-last": {
    wait: 32,
    events: [
      { t: 0, op: "call", args: [1] },
      { t: 40, op: "call", args: [2] },
    ],
  },
  "func-throws": {
    wait: 32,
    throwing: true,
    events: [{ t: 0, op: "call", args: ["boom"] }],
  },
  "time-rewind": {
    wait: 32,
    events: [
      { t: 50, op: "call", args: ["later"] },
      { t: 10, op: "call", args: ["earlier"] },
    ],
  },
};

export async function runDebounceScript(
  debounceFn: Function,
  script: DebounceScript,
  clock: FakeClock,
): Promise<{ spies: SpyEvent[]; returns: unknown[]; flushResults: unknown[] }> {
  const spies: SpyEvent[] = [];
  const returns: unknown[] = [];
  const flushResults: unknown[] = [];
  const ownedInstall = !clock.isInstalled();
  clock.install();
  try {
    clock.reset(0);
    const spy = function spy(this: unknown, ...args: unknown[]): unknown {
      const ev: SpyEvent = { t: clock.getTime(), thisArg: this, args };
      if (script.throwing) {
        const err = new Error("Expected a function");
        err.name = "TypeError";
        ev.threw = { name: err.name, message: err.message };
        spies.push(ev);
        throw err;
      }
      spies.push(ev);
      return args[0];
    };
    const wrapper = debounceFn(spy, script.wait, script.options) as {
      (...args: unknown[]): unknown;
      cancel?: () => void;
      flush?: () => unknown;
    };
    for (const ev of script.events) {
      await seek(clock, ev.t);
      try {
        if (ev.op === "call") {
          const ctx = ev.thisArg ?? Object.create(null);
          returns.push(wrapper.call(ctx, ...ev.args));
        } else if (ev.op === "cancel") {
          wrapper.cancel?.();
        } else if (ev.op === "flush") {
          flushResults.push(wrapper.flush?.());
        }
      } catch {
        // spy already recorded threw
      }
    }
    const tail = script.wait + (script.options?.maxWait ?? 0) + 1;
    try {
      await clock.advance(tail);
    } catch {
      // trailing invoke threw
    }
    return { spies, returns, flushResults };
  } finally {
    if (ownedInstall) clock.uninstall();
  }
}

async function seek(clock: FakeClock, t: number): Promise<void> {
  const now = clock.getTime();
  if (t < now) {
    clock.set(t);
    return;
  }
  if (t > now) await clock.advance(t - now);
}

/** Pick taxonomy scripts for a user envelope (observed options + default if argc===2). */
export function taxonomyForObserved(opts: {
  exportName: string;
  observedArgc: number[];
  optionLiterals?: unknown[];
  /** When true (Slim CI), run the full 14-script taxonomy. */
  full?: boolean;
}): DebounceScript[] {
  if (!isTimerSymbol(opts.exportName)) return [];
  if (opts.full) return Object.values(TAXONOMY);
  const argc = new Set(opts.observedArgc);
  const hasDefault = argc.has(2) || argc.size === 0;
  const hasOptions = [...argc].some((n) => n >= 3);
  const out: DebounceScript[] = [];
  if (hasDefault) {
    for (const k of [
      "trailing-single",
      "trailing-burst",
      "cancel-mid",
      "flush-mid",
      "flush-empty",
      "wait-zero",
      "this-and-args",
      "return-last",
      "func-throws",
      "time-rewind",
    ] as const) {
      out.push(TAXONOMY[k]!);
    }
  }
  if (hasOptions) {
    const lits = opts.optionLiterals ?? [];
    const wantLeading = lits.some((o) => isRecord(o) && o.leading === true);
    const wantMax = lits.some((o) => isRecord(o) && "maxWait" in o);
    const wantTrailingCombo = lits.some(
      (o) => isRecord(o) && o.leading === true && o.trailing !== false,
    );
    if (wantLeading) out.push(TAXONOMY["leading-only"]!);
    if (wantTrailingCombo) {
      out.push(TAXONOMY["leading-trailing-one"]!, TAXONOMY["leading-trailing-two"]!);
    }
    if (wantMax) out.push(TAXONOMY["maxWait-stream"]!);
    if (!wantLeading && !wantMax && !wantTrailingCombo) {
      out.push(
        TAXONOMY["leading-only"]!,
        TAXONOMY["leading-trailing-one"]!,
        TAXONOMY["leading-trailing-two"]!,
        TAXONOMY["maxWait-stream"]!,
      );
    }
  }
  return out;
}

export function isTimerSymbol(name: string): boolean {
  return /^(debounce|throttle)$/i.test(name);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
