/** Wait for worker orig/slim load before any case timer starts. Independent of --budget-ms. */
export declare const STARTUP_MS = 2000;
/** Bound on Worker.terminate() during pool close / replace. */
export declare const SHUTDOWN_MS = 250;
/** Process-wall slack covering worker spawn. Alias of STARTUP_MS. Not a whole-run kill switch. */
export declare const BUDGET_SLACK_MS = 2000;
/** Extra pickFuzzArgs cases after the required prefix. Not a wall-clock drain. */
export declare function extraCaseQuota(budgetMs: number): number;
/** Monotonic elapsed ms. Immune to the fake clock's Date.now patch. */
export declare function wallMs(): number;
export declare function nativeTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
export declare function nativeClear(id: ReturnType<typeof setTimeout>): void;
export interface FakeClock {
    now(): number;
    install(): void;
    uninstall(): void;
    isInstalled(): boolean;
    reset(ms?: number): void;
    advance(ms: number): Promise<void>;
    set(ms: number): void;
    getTime(): number;
}
export declare function createFakeClock(start?: number): FakeClock;
