import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { invoke, equalResults, equal } from "./equal.ts";
import { createFakeClock, type FakeClock } from "./clock.ts";
import {
  runDebounceScript,
  type DebounceScript,
  type SpyEvent,
} from "./debounce-driver.ts";
import type { HyrumFlags, SlimValue } from "../envelope/types.ts";
import { serialize, snapshot } from "../trace/serialize.ts";
import { hydrate } from "./gen.ts";

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
  clock?: boolean;
  slimHash?: string;
}): WorkerPool {
  if (opts.workers > 1) return createThreadPool(opts);
  return createInProcessPool(opts);
}

/** Bust ESM cache of the slim module for this generate attempt. */
export function withSlimQuery(spec: string, hash?: string): string {
  const href = spec.startsWith("file:") ? spec : pathToFileURL(spec).href;
  if (!hash) return href;
  const url = new URL(href);
  url.searchParams.set("slim", hash);
  return url.href;
}

function workerExecArgv(): string[] {
  return process.execArgv.filter((a) => a !== "--test" && !a.startsWith("--test-"));
}

function createThreadPool(opts: {
  workers: number;
  origModule: string;
  slimModule: string;
  symbols: string[];
  clock?: boolean;
  slimHash?: string;
}): WorkerPool {
  const n = Math.max(1, opts.workers);
  const workers: Worker[] = [];
  const idle: Worker[] = [];
  const waiters: Array<(w: Worker) => void> = [];
  let closed = false;
  let nextId = 1;
  const pending = new Map<number, { resolve: (r: FuzzResult) => void; reject: (e: unknown) => void }>();
  const slimModule = withSlimQuery(opts.slimModule, opts.slimHash);

  function spawn(): Worker {
    const w = new Worker(new URL("./worker-thread.ts", import.meta.url), {
      execArgv: workerExecArgv(),
      workerData: {
        origModule: opts.origModule,
        slimModule,
        symbols: opts.symbols,
        clock: opts.clock === true,
      },
    });
    w.on("message", (msg: { type: string; id?: number; result?: FuzzResult; error?: string }) => {
      if (msg.type === "result" && msg.id !== undefined && msg.result) {
        pending.get(msg.id)?.resolve(fromCloneableResult(msg.result));
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
          w.postMessage({ type: "run", id, job: toCloneableJob(job) });
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
  clock?: boolean;
  slimHash?: string;
}): WorkerPool {
  let orig: Record<string, Function> | null = null;
  let slim: Record<string, Function> | null = null;
  let persistClock: FakeClock | undefined;
  let loading: Promise<void> | null = null;

  async function ensure(): Promise<void> {
    if (orig && slim) return;
    if (!loading) {
      loading = (async () => {
        if (opts.clock) {
          persistClock = createFakeClock(0);
          persistClock.install();
        }
        orig = await loadOrig(opts.origModule);
        slim = await loadSlim(withSlimQuery(opts.slimModule, opts.slimHash));
      })();
    }
    await loading;
  }

  return {
    async runCase(job: FuzzJob): Promise<FuzzResult> {
      await ensure();
      return runJob(orig!, slim!, job, persistClock);
    },
    async close(): Promise<void> {
      persistClock?.uninstall();
      persistClock = undefined;
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
  if (m == null) return {};
  const out: Record<string, Function> = {};
  if (typeof m === "function") {
    out.default = m;
    Object.assign(out, pickFns(m as unknown as object));
  }
  if (typeof m === "object" || typeof m === "function") {
    const rec = m as Record<string, unknown>;
    Object.assign(out, pickFns(rec));
    const def = rec.default;
    if (typeof def === "function") {
      out.default = def;
      Object.assign(out, pickFns(def as unknown as object));
    } else if (def && typeof def === "object") {
      Object.assign(out, pickFns(def as object));
    }
  }
  return out;
}

function pickFns(rec: object): Record<string, Function> {
  const out: Record<string, Function> = {};
  for (const k of Object.getOwnPropertyNames(rec)) {
    let v: unknown;
    try {
      v = (rec as Record<string, unknown>)[k];
    } catch {
      continue;
    }
    if (typeof v === "function") out[k] = v;
  }
  return out;
}

export function toCloneableJob(job: FuzzJob): FuzzJob {
  return {
    ...job,
    args: snapshot(job.args),
    thisArg: job.thisArg === undefined ? undefined : serialize(job.thisArg),
  };
}

export function fromCloneableJob(job: FuzzJob): FuzzJob {
  return {
    ...job,
    args: job.args.map((a) => hydrate(a as SlimValue)),
    thisArg: job.thisArg === undefined ? undefined : hydrate(job.thisArg as SlimValue),
  };
}

export function toCloneableResult(result: FuzzResult): FuzzResult {
  return {
    symbol: result.symbol,
    ok: result.ok,
    reason: result.reason,
    args: result.args === undefined ? undefined : snapshot(result.args),
  };
}

export function fromCloneableResult(result: FuzzResult): FuzzResult {
  return {
    symbol: result.symbol,
    ok: result.ok,
    reason: result.reason,
    args: result.args === undefined ? undefined : result.args.map((a) => hydrate(a as SlimValue)),
  };
}

export async function runJob(
  original: Record<string, Function>,
  replacement: Record<string, Function>,
  job: FuzzJob,
  persistClock?: FakeClock,
): Promise<FuzzResult> {
  const origFn = original[job.symbol];
  const slimFn = replacement[job.symbol];
  if (typeof origFn !== "function" || typeof slimFn !== "function") {
    return { symbol: job.symbol, ok: false, reason: `missing function ${job.symbol}`, args: job.args };
  }
  if (job.kind === "debounce" && job.script) {
    const clockOrig = persistClock ?? createFakeClock(0);
    const clockSlim = persistClock ?? createFakeClock(0);
    persistClock?.reset(0);
    const a = await runDebounceScript(origFn, job.script, clockOrig);
    persistClock?.reset(0);
    const b = await runDebounceScript(slimFn, job.script, clockSlim);
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
