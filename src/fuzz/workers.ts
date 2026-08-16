import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { invoke, equalResults, equal } from "./equal.ts";
import { createFakeClock } from "./clock.ts";
import {
  runDebounceScript,
  type DebounceScript,
  type SpyEvent,
} from "./debounce-driver.ts";
import type { HyrumFlags } from "../envelope/types.ts";

export interface FuzzJob {
  symbol: string;
  args: unknown[];
  thisArg?: unknown;
  kind?: "call" | "debounce";
  script?: DebounceScript;
  hyrum?: Partial<HyrumFlags>;
}

export interface FuzzResult {
  symbol: string;
  ok: boolean;
  reason?: string;
  args?: unknown[];
  spiesOrig?: SpyEvent[];
  spiesSlim?: SpyEvent[];
}

export interface WorkerPool {
  runCase(job: FuzzJob): Promise<FuzzResult>;
  close(): Promise<void>;
}

export function createPool(opts: {
  workers: number;
  origModule: string;
  slimModule: string;
  symbols: string[];
}): WorkerPool {
  if (opts.workers > 1) return createThreadPool(opts);
  return createInProcessPool(opts);
}

function createThreadPool(opts: {
  workers: number;
  origModule: string;
  slimModule: string;
  symbols: string[];
}): WorkerPool {
  const n = Math.max(1, opts.workers);
  const workers: Worker[] = [];
  const idle: Worker[] = [];
  const waiters: Array<(w: Worker) => void> = [];
  let closed = false;
  let nextId = 1;
  const pending = new Map<number, { resolve: (r: FuzzResult) => void; reject: (e: unknown) => void }>();

  function spawn(): Worker {
    const w = new Worker(new URL("./worker-thread.ts", import.meta.url), {
      execArgv: process.execArgv,
      workerData: {
        origModule: opts.origModule,
        slimModule: opts.slimModule,
        symbols: opts.symbols,
      },
    });
    w.on("message", (msg: { type: string; id?: number; result?: FuzzResult; error?: string }) => {
      if (msg.type === "result" && msg.id !== undefined && msg.result) {
        pending.get(msg.id)?.resolve(msg.result);
        pending.delete(msg.id);
      } else if (msg.type === "error" && msg.id !== undefined) {
        pending.get(msg.id)?.reject(new Error(msg.error ?? "worker error"));
        pending.delete(msg.id);
      }
    });
    w.on("error", (err) => {
      for (const [, p] of pending) p.reject(err);
      pending.clear();
    });
    return w;
  }

  for (let i = 0; i < n; i++) {
    const w = spawn();
    workers.push(w);
    idle.push(w);
  }

  async function acquire(): Promise<Worker> {
    const w = idle.pop();
    if (w) return w;
    return new Promise((resolve) => waiters.push(resolve));
  }

  function release(w: Worker): void {
    const waiter = waiters.shift();
    if (waiter) waiter(w);
    else idle.push(w);
  }

  return {
    async runCase(job: FuzzJob): Promise<FuzzResult> {
      if (closed) throw new Error("WorkerPool closed");
      const w = await acquire();
      const id = nextId++;
      try {
        return await new Promise<FuzzResult>((resolve, reject) => {
          pending.set(id, { resolve, reject });
          w.postMessage({ type: "run", id, job });
        });
      } finally {
        release(w);
      }
    },
    async close(): Promise<void> {
      closed = true;
      await Promise.all(workers.map((w) => w.terminate()));
      idle.length = 0;
    },
  };
}

function createInProcessPool(opts: {
  origModule: string;
  slimModule: string;
  symbols: string[];
}): WorkerPool {
  let orig: Record<string, Function> | null = null;
  let slim: Record<string, Function> | null = null;
  let loading: Promise<void> | null = null;

  async function ensure(): Promise<void> {
    if (orig && slim) return;
    if (!loading) {
      loading = (async () => {
        orig = await loadOrig(opts.origModule);
        slim = await loadSlim(opts.slimModule);
      })();
    }
    await loading;
  }

  return {
    async runCase(job: FuzzJob): Promise<FuzzResult> {
      await ensure();
      return runJob(orig!, slim!, job);
    },
    async close(): Promise<void> {
      orig = null;
      slim = null;
    },
  };
}

export async function loadOrig(spec: string): Promise<Record<string, Function>> {
  const req = createRequire(join(process.cwd(), "package.json"));
  try {
    return unwrapModule(req(spec));
  } catch {
    const m = await import(spec);
    return unwrapModule(m);
  }
}

export async function loadSlim(spec: string): Promise<Record<string, Function>> {
  const href = spec.startsWith("file:") ? spec : pathToFileURL(spec).href;
  const m = await import(href);
  return unwrapModule(m);
}

function unwrapModule(m: unknown): Record<string, Function> {
  if (typeof m !== "object" || m === null) return {};
  const rec = m as Record<string, unknown>;
  const def = rec.default;
  if (typeof def === "function") {
    const out: Record<string, Function> = { default: def, ...(pickFns(rec)) };
    if (typeof (def as Function & { get?: unknown }).get === "function") {
      Object.assign(out, pickFns(def as unknown as Record<string, unknown>));
    }
    return out;
  }
  if (def && typeof def === "object") {
    return { ...pickFns(def as Record<string, unknown>), ...pickFns(rec) };
  }
  return pickFns(rec);
}

function pickFns(rec: Record<string, unknown>): Record<string, Function> {
  const out: Record<string, Function> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === "function") out[k] = v;
  }
  return out;
}

export async function runJob(
  original: Record<string, Function>,
  replacement: Record<string, Function>,
  job: FuzzJob,
): Promise<FuzzResult> {
  const origFn = original[job.symbol];
  const slimFn = replacement[job.symbol];
  if (typeof origFn !== "function" || typeof slimFn !== "function") {
    return { symbol: job.symbol, ok: false, reason: `missing function ${job.symbol}`, args: job.args };
  }
  if (job.kind === "debounce" && job.script) {
    const clock = createFakeClock(0);
    const a = await runDebounceScript(origFn, job.script, clock);
    const b = await runDebounceScript(slimFn, job.script, clock);
    if (!equal(a.spies, b.spies, job.hyrum)) {
      return {
        symbol: job.symbol,
        ok: false,
        reason: "debounce spy timeline mismatch",
        spiesOrig: a.spies,
        spiesSlim: b.spies,
      };
    }
    if (!equal(a.returns, b.returns, job.hyrum) || !equal(a.flushResults, b.flushResults, job.hyrum)) {
      return { symbol: job.symbol, ok: false, reason: "debounce return/flush mismatch" };
    }
    return { symbol: job.symbol, ok: true };
  }
  const o = invoke(origFn, job.args, job.thisArg);
  const s = invoke(slimFn, job.args, job.thisArg);
  const cmp = equalResults(o, s, job.hyrum);
  return {
    symbol: job.symbol,
    ok: cmp.ok,
    reason: cmp.reason,
    args: job.args,
  };
}
