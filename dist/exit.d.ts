/** Slim process exit codes. */
export declare const EXIT_OK = 0;
export declare const EXIT_FAIL = 1;
export declare const EXIT_USAGE = 2;
export declare const EXIT_REFUSED = 3;
export declare const EXIT_ENV = 4;
export declare class SlimExit extends Error {
    readonly code: number;
    readonly json?: unknown;
    readonly skipJson: boolean;
    constructor(code: number, message: string, opts?: {
        json?: unknown;
        skipJson?: boolean;
    });
}
