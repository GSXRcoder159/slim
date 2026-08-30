import type { HyrumFlags } from "../envelope/types.ts";
export interface EqualOptions {
    /** When true, -0 and +0 are not equal (Object.is). Default SameValueZero. */
    signedZero?: boolean;
    /** When true, enumerable key insertion order must match. */
    keyOrder?: boolean;
}
export type CallOutcome = {
    ok: true;
    value: unknown;
    argsAfter: unknown[];
    thisAfter?: unknown;
} | {
    ok: false;
    error: {
        name: string;
        message: string;
        code?: unknown;
    };
    argsAfter: unknown[];
    thisAfter?: unknown;
};
export declare function normalizeError(e: unknown): {
    name: string;
    message: string;
    code?: unknown;
};
/** Clone args and receiver, call `fn`, capture return/throw and post-call arg/this state. */
export declare function invoke(fn: Function, args: unknown[], thisArg?: unknown): CallOutcome;
/** Await thenable return values so Promise-returning APIs compare by settlement. */
export declare function settleOutcome(out: CallOutcome, timeoutMs?: number): Promise<CallOutcome>;
export declare function equalThrown(a: {
    name: string;
    message: string;
    code?: unknown;
}, b: {
    name: string;
    message: string;
    code?: unknown;
}, hyrum?: Partial<HyrumFlags>): boolean;
export declare function equal(a: unknown, b: unknown, hyrum?: Partial<HyrumFlags>, options?: EqualOptions): boolean;
export declare function equalResults(orig: CallOutcome, slim: CallOutcome, hyrum?: Partial<HyrumFlags>, options?: EqualOptions): {
    ok: boolean;
    reason?: string;
};
