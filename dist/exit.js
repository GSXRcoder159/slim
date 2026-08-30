/** Slim process exit codes. */
export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;
export const EXIT_ENV = 4;
export class SlimExit extends Error {
    code;
    json;
    skipJson;
    constructor(code, message, opts) {
        super(message);
        this.name = "SlimExit";
        this.code = code;
        this.json = opts?.json;
        this.skipJson = opts?.skipJson === true;
    }
}
//# sourceMappingURL=exit.js.map