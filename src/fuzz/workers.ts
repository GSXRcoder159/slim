import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { siblingModule } from "../runtime-path.ts";
import { EXIT_ENV, EXIT_FAIL, SlimExit } from "../exit.ts";
import { invoke, equalResults, equal, settleOutcome } from "./equal.ts";
import {
  setTimeout as timeoutFn,
  clearTimeout as clearTimeoutFn,
  setImmediate as nextTurn,
} from "node:timers";
import { createFakeClock, STARTUP_MS, SHUTDOWN_MS, wallMs, type FakeClock } from "./clock.ts";
import { withSeededCrypto } from "./crypto.ts";
import { minimize } from "./minimize.ts";
import {
  runDebounceScript,
  type DebounceScript,
  type SpyEvent,
} from "./debounce-driver.ts";
import type { HyrumFlags, SlimValue } from "../envelope/types.ts";
import { deserializeEvent, serializeEvent, snapshot } from "../trace/serialize.ts";

const MINIMIZE_MS = 2000;
const JOB_TIMEOUT_CAP_MS = 5000;

export interface FuzzJob {
  symbol: string;
  args: unknown[];
  thisArg?: unknown;
  kind?: "call" | "debounce";
  script?: DebounceScript;
  hyrum?: Partial<HyrumFlags>;
  cryptoSeed?: number;
}

export interface FuzzResult {
  symbol: string;
  ok: boolean;
  reason?: string;
  args?: unknown[];
  minimized?: unknown[];
  spiesOrig?: SpyEvent[];
  spiesSlim?: SpyEvent[];
}

export interface WorkerPool {
  runCase(job: FuzzJob, timeoutMs?: number): Promise<FuzzResult>;
  /** Wait until every worker has loaded orig/slim, or throw insufficient startup. */
  ready(): Promise<void>;
  close(): Promise<void>;
}

export function createPool(opts: {
  workers: number;
  origModule: string;
  slimModule: string;
  symbols: string[];
  clock?: boolean;
  slimHash?: string;
  projectRoot?: string;
  timeoutMs?: number;
}): WorkerPool {
  if (opts.workers > 1) return createThreadPool(opts);
  return createInProcessPool(opts);
}

/** Resolve worker-thread next to this module. Prefers `.js` (pack) then `.ts` (source). */
export function workerThreadUrl(metaUrl: string = import.meta.url): URL {
  return pathToFileURL(siblingModule(metaUrl, "worker-thread"));
}

/** Bust ESM cache of the slim module for this generate attempt. */
export function withSlimQuery(spec: string, hash?: string): string {
  const href = spec.startsWith("file:") ? spec : pathToFileURL(spec).href;
  if (!hash) return href;
  const url = new URL(href);
  url.searchParams.set("slim", hash);
  return url.href;
}

function workerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

const WORKER_EXEC_FLAG =
  /^(?:--experimental-strip-types|--experimental-require-module|--import|--require)(?:=|$)/;

/** Node 24 runners inject V8/TLS flags that `new Worker` rejects (ERR_WORKER_INVALID_EXEC_ARGV). */
export function workerExecArgv(argv: readonly string[] = process.execArgv): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--test" || a.startsWith("--test-")) continue;
    if (!WORKER_EXEC_FLAG.test(a)) continue;
    out.push(a);
    if (!a.includes("=") && (a === "--import" || a === "--require")) {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        out.push(next);
        i += 1;
      }
    }
  }
  return out;
}

export function defaultJobTimeoutMs(budgetMs: number): number {
  return Math.max(50, Math.min(JOB_TIMEOUT_CAP_MS, Math.max(0, budgetMs) + 50));
}

function terminateSoon(w: Worker, ms = SHUTDOWN_MS): Promise<void> {
  try {
    w.unref();
  } catch {
    /* already gone */
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      try {
        w.unref();
      } catch {
        /* gone */
      }
      resolve();
    };
    timeoutFn(finish, ms);
    Promise.resolve(w.terminate()).then(finish, finish);
  });
}

function raceTimeout<T>(promise: Promise<T>, ms: number, err: SlimExit): Promise<T> {
  let timer: ReturnType<typeof timeoutFn> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = timeoutFn(() => reject(err), Math.max(1, ms));
    }),
  ]).finally(() => {
    if (timer) clearTimeoutFn(timer);
  });
}

function createThreadPool(opts: {
  workers: number;
  origModule: string;
  slimModule: string;
  symbols: string[];
  clock?: boolean;
  slimHash?: string;
  projectRoot?: string;
  timeoutMs?: number;
}): WorkerPool {
  const n = Math.max(1, opts.workers);
  const defaultTimeout = opts.timeoutMs ?? JOB_TIMEOUT_CAP_MS;
  const workers: Worker[] = [];
  const idle: Worker[] = [];
  const retiring: Worker[] = [];
  const waiters: Array<{ resolve: (w: Worker) => void; reject: (e: unknown) => void }> = [];
  let closed = false;
  let nextId = 1;
  const startedAt = wallMs();
  const pending = new Map<
    number,
    { resolve: (r: FuzzResult) => void; reject: (e: unknown) => void; worker: Worker }
  >();
  const inflight = new Map<Worker, number>();
  const readyAt = new WeakMap<Worker, Promise<void>>();
  const spawnedAt = new WeakMap<Worker, number>();
  const slimModule = withSlimQuery(opts.slimModule, opts.slimHash);

  function failJob(id: number, err: unknown): void {
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    inflight.delete(waiter.worker);
    waiter.reject(err);
  }

  function succeedJob(id: number, result: FuzzResult): void {
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    inflight.delete(waiter.worker);
    waiter.resolve(result);
  }

  function spawn(): Worker {
    let settleReady: () => void;
    let failReady: (e: unknown) => void;
    let settled = false;
    const ready = new Promise<void>((resolve, reject) => {
      settleReady = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      failReady = (e) => {
        if (settled) return;
        settled = true;
        reject(e);
      };
    });
    const w = new Worker(workerThreadUrl(), {
      execArgv: workerExecArgv(),
      env: workerEnv(),
      workerData: {
        origModule: opts.origModule,
        slimModule,
        symbols: opts.symbols,
        clock: opts.clock === true,
        projectRoot: opts.projectRoot,
      },
    });
    readyAt.set(w, ready);
    spawnedAt.set(w, wallMs());
    w.on("message", (msg: { type: string; id?: number; result?: FuzzResult; error?: string }) => {
      if (msg.type === "ready") {
        settleReady();
        return;
      }
      if (closed || !workers.includes(w)) return;
      if (msg.type === "error" && msg.id === undefined) {
        failReady(new SlimExit(EXIT_ENV, `fuzz worker crashed: ${msg.error ?? "worker error"}`));
        return;
      }
      if (msg.type === "result" && msg.id !== undefined && msg.result) {
        succeedJob(msg.id, fromCloneableResult(msg.result));
      } else if (msg.type === "error" && msg.id !== undefined) {
        const text = msg.error ?? "worker error";
        failJob(
          msg.id,
          /malformed/i.test(text) ? new SlimExit(EXIT_ENV, text) : new Error(text),
        );
      } else if (msg.id !== undefined) {
        failJob(msg.id, new SlimExit(EXIT_ENV, "malformed worker message"));
      }
    });
    w.on("error", (err) => {
      const crash = new SlimExit(EXIT_ENV, `fuzz worker crashed: ${err.message}`);
      failReady(crash);
      const id = inflight.get(w);
      if (id !== undefined) failJob(id, crash);
    });
    w.on("exit", (code) => {
      if (closed) return;
      const crash = new SlimExit(EXIT_ENV, `fuzz worker crashed (exit ${code ?? 1})`);
      failReady(crash);
      const id = inflight.get(w);
      if (id !== undefined) failJob(id, crash);
    });
    return w;
  }

  function retire(dead: Worker): void {
    inflight.delete(dead);
    const idleAt = idle.indexOf(dead);
    if (idleAt >= 0) idle.splice(idleAt, 1);
    const wi = workers.indexOf(dead);
    if (wi >= 0) workers.splice(wi, 1);
    retiring.push(dead);
    // Never terminate() on this turn: killing a tight-loop isolate can stall
    // the event loop and prevent sibling job timers from firing.
    nextTurn(() => {
      void terminateSoon(dead);
    });
  }

  function replaceWorker(dead: Worker): Worker | undefined {
    retire(dead);
    if (closed) return undefined;
    const w = spawn();
    workers.push(w);
    return w;
  }

  for (let i = 0; i < n; i++) {
    const w = spawn();
    workers.push(w);
    idle.push(w);
  }

  async function waitReady(w: Worker): Promise<void> {
    const p = readyAt.get(w);
    if (!p) throw new SlimExit(EXIT_ENV, "insufficient startup budget");
    const from = spawnedAt.get(w) ?? startedAt;
    const left = Math.max(1, STARTUP_MS - (wallMs() - from));
    await raceTimeout(p, left, new SlimExit(EXIT_ENV, "insufficient startup budget"));
  }

  async function acquire(): Promise<Worker> {
    if (closed) throw new SlimExit(EXIT_ENV, "fuzz worker pool closed");
    const w = idle.pop() ?? (await new Promise<Worker>((resolve, reject) => waiters.push({ resolve, reject })));
    await waitReady(w);
    return w;
  }

  function release(w: Worker): void {
    if (closed || !workers.includes(w)) return;
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(w);
    else idle.push(w);
  }

  return {
    async ready(): Promise<void> {
      if (closed) throw new SlimExit(EXIT_ENV, "fuzz worker pool closed");
      const left = Math.max(1, STARTUP_MS - (wallMs() - startedAt));
      await raceTimeout(
        Promise.all(workers.map((w) => waitReady(w))),
        left,
        new SlimExit(EXIT_ENV, "insufficient startup budget"),
      );
    },
    async runCase(job: FuzzJob, timeoutMs = defaultTimeout): Promise<FuzzResult> {
      if (closed) throw new SlimExit(EXIT_ENV, "fuzz worker pool closed");
      const acquired = await acquire();
      const id = nextId++;
      let replaced = false;
      let timer: ReturnType<typeof timeoutFn> | undefined;
      try {
        let cloneable: FuzzJob;
        try {
          cloneable = toCloneableJob(job);
        } catch (e) {
          throw new SlimExit(
            EXIT_FAIL,
            `serialization failure: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        return await new Promise<FuzzResult>((resolve, reject) => {
          pending.set(id, { resolve, reject, worker: acquired });
          inflight.set(acquired, id);
          timer = timeoutFn(() => {
            failJob(id, new SlimExit(EXIT_ENV, "fuzz worker timeout"));
          }, Math.max(1, timeoutMs));
          try {
            acquired.postMessage({ type: "run", id, job: cloneable });
          } catch (e) {
            failJob(
              id,
              new SlimExit(
                EXIT_FAIL,
                `serialization failure: ${e instanceof Error ? e.message : String(e)}`,
              ),
            );
          }
        });
      } catch (e) {
        if (e instanceof SlimExit && e.code === EXIT_ENV && !closed) {
          replaced = true;
          const fresh = replaceWorker(acquired);
          if (fresh) release(fresh);
        }
        throw e;
      } finally {
        if (timer) clearTimeoutFn(timer);
        inflight.delete(acquired);
        pending.delete(id);
        if (!replaced) release(acquired);
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const [, p] of pending) {
        p.reject(new SlimExit(EXIT_ENV, "fuzz worker pool closed"));
      }
      pending.clear();
      inflight.clear();
      for (const waiter of waiters) {
        waiter.reject(new SlimExit(EXIT_ENV, "fuzz worker pool closed"));
      }
      waiters.length = 0;
      const dying = [...new Set([...workers, ...retiring])];
      workers.length = 0;
      retiring.length = 0;
      idle.length = 0;
      await Promise.all(dying.map((w) => terminateSoon(w)));
    },
  };
}

function createInProcessPool(opts: {
  origModule: string;
  slimModule: string;
  symbols: string[];
  clock?: boolean;
  slimHash?: string;
  projectRoot?: string;
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
        orig = await loadOrig(opts.origModule, opts.projectRoot);
        slim = await loadSlim(withSlimQuery(opts.slimModule, opts.slimHash));
      })();
    }
    await loading;
  }

  return {
    async ready(): Promise<void> {
      await ensure();
    },
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

function moduleHref(spec: string): string {
  if (/^(?:file|data|node):/i.test(spec)) return spec;
  return pathToFileURL(spec).href;
}

export async function loadOrig(
  spec: string,
  projectRoot = process.cwd(),
): Promise<Record<string, Function>> {
  const req = createRequire(join(projectRoot, "package.json"));
  try {
    return unwrapModule(req(spec));
  } catch {
    const m = await import(moduleHref(spec));
    return unwrapModule(m);
  }
}

export async function loadSlim(spec: string): Promise<Record<string, Function>> {
  const m = await import(moduleHref(spec));
  return unwrapModule(m);
}

function unwrapModule(m: unknown): Record<string, Function> {
  if (m == null) return {};
  const out: Record<string, Function> = {};
  if (typeof m === "function") {
    out.default = m;
    aliasFnName(out, m);
    Object.assign(out, pickFns(m as unknown as object));
  }
  if (typeof m === "object" || typeof m === "function") {
    const rec = m as Record<string, unknown>;
    Object.assign(out, pickFns(rec));
    const def = rec.default;
    if (typeof def === "function") {
      out.default = def;
      aliasFnName(out, def);
      Object.assign(out, pickFns(def as unknown as object));
    } else if (def && typeof def === "object") {
      Object.assign(out, pickFns(def as object));
    }
  }
  return out;
}

function aliasFnName(out: Record<string, Function>, fn: Function): void {
  const n = fn.name;
  if (n && n !== "default" && /^[A-Za-z_$][\w$]*$/.test(n) && typeof out[n] !== "function") {
    out[n] = fn as (...args: unknown[]) => unknown;
  }
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
  const ev = serializeEvent({ args: job.args, thisArg: job.thisArg });
  return {
    ...job,
    args: ev.args,
    thisArg: ev.thisArg,
  };
}

export function fromCloneableJob(job: FuzzJob): FuzzJob {
  const ev = deserializeEvent({
    args: job.args as SlimValue[],
    thisArg: job.thisArg === undefined ? undefined : (job.thisArg as SlimValue),
  });
  return {
    ...job,
    args: ev.args,
    thisArg: ev.thisArg,
  };
}

export function toCloneableResult(result: FuzzResult): FuzzResult {
  return {
    symbol: result.symbol,
    ok: result.ok,
    reason: result.reason,
    args: result.args === undefined ? undefined : snapshot(result.args),
    minimized: result.minimized === undefined ? undefined : snapshot(result.minimized),
  };
}

export function fromCloneableResult(result: FuzzResult): FuzzResult {
  return {
    symbol: result.symbol,
    ok: result.ok,
    reason: result.reason,
    args:
      result.args === undefined
        ? undefined
        : deserializeEvent({ args: result.args as SlimValue[] }).args,
    minimized:
      result.minimized === undefined
        ? undefined
        : deserializeEvent({ args: result.minimized as SlimValue[] }).args,
  };
}

function cryptoArgs(symbol: string, args: unknown[]): unknown[] {
  if (symbol === "v4" && args.length === 0) {
    return [{ random: globalThis.crypto.getRandomValues(new Uint8Array(16)) }];
  }
  return args;
}

export function withFrozenNow<T>(fn: () => T): T {
  const now = Date.now();
  const orig = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = orig;
  }
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
        args: job.args,
      };
    }
    if (!equal(a.returns, b.returns, job.hyrum) || !equal(a.flushResults, b.flushResults, job.hyrum)) {
      return { symbol: job.symbol, ok: false, reason: "debounce return/flush mismatch", args: job.args };
    }
    return { symbol: job.symbol, ok: true };
  }
  const raw = withFrozenNow(() =>
    job.cryptoSeed === undefined
      ? { o: invoke(origFn, job.args, job.thisArg), s: invoke(slimFn, job.args, job.thisArg) }
      : {
          o: withSeededCrypto(job.cryptoSeed, () =>
            invoke(origFn, cryptoArgs(job.symbol, job.args), job.thisArg),
          ),
          s: withSeededCrypto(job.cryptoSeed, () =>
            invoke(slimFn, cryptoArgs(job.symbol, job.args), job.thisArg),
          ),
        },
  );
  const pair = { o: await settleOutcome(raw.o), s: await settleOutcome(raw.s) };
  const cmp = equalResults(pair.o, pair.s, job.hyrum);
  if (cmp.ok) {
    return { symbol: job.symbol, ok: true, args: job.args };
  }
  const pred = (a: unknown[]): boolean => {
    const trial = (): { o: ReturnType<typeof invoke>; s: ReturnType<typeof invoke> } => ({
      o: invoke(origFn, a, job.thisArg),
      s: invoke(slimFn, a, job.thisArg),
    });
    const both =
      job.cryptoSeed === undefined
        ? trial()
        : {
            o: withSeededCrypto(job.cryptoSeed, () => invoke(origFn, cryptoArgs(job.symbol, a), job.thisArg)),
            s: withSeededCrypto(job.cryptoSeed, () => invoke(slimFn, cryptoArgs(job.symbol, a), job.thisArg)),
          };
    return !equalResults(both.o, both.s, job.hyrum).ok;
  };
  const minimized = minimize(job.args, pred, MINIMIZE_MS);
  return {
    symbol: job.symbol,
    ok: false,
    reason: cmp.reason,
    args: job.args,
    minimized,
  };
}
