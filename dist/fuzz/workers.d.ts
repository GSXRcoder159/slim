import { type FakeClock } from "./clock.ts";
import { type DebounceScript, type SpyEvent } from "./debounce-driver.ts";
import type { HyrumFlags } from "../envelope/types.ts";
/** Per-case stall timeout after worker ready. Independent of --budget-ms extra-case quota. */
export declare const JOB_TIMEOUT_CAP_MS = 5000;
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
export declare function createPool(opts: {
    workers: number;
    origModule: string;
    slimModule: string;
    symbols: string[];
    clock?: boolean;
    slimHash?: string;
    projectRoot?: string;
    timeoutMs?: number;
}): WorkerPool;
/** Resolve worker-thread next to this module. Prefers `.js` (pack) then `.ts` (source). */
export declare function workerThreadUrl(metaUrl?: string): URL;
/** Bust ESM cache of the slim module for this generate attempt. */
export declare function withSlimQuery(spec: string, hash?: string): string;
/** Node 24 runners inject V8/TLS flags that `new Worker` rejects (ERR_WORKER_INVALID_EXEC_ARGV). */
export declare function workerExecArgv(argv?: readonly string[]): string[];
export declare function defaultJobTimeoutMs(): number;
export declare function loadOrig(spec: string, projectRoot?: string): Promise<Record<string, Function>>;
export declare function loadSlim(spec: string): Promise<Record<string, Function>>;
export declare function toCloneableJob(job: FuzzJob): FuzzJob;
export declare function fromCloneableJob(job: FuzzJob): FuzzJob;
export declare function toCloneableResult(result: FuzzResult): FuzzResult;
export declare function fromCloneableResult(result: FuzzResult): FuzzResult;
export declare function withFrozenNow<T>(fn: () => T): T;
export declare function runJob(original: Record<string, Function>, replacement: Record<string, Function>, job: FuzzJob, persistClock?: FakeClock): Promise<FuzzResult>;
