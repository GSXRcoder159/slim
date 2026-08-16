/** Slim process exit codes. */
export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;
export const EXIT_ENV = 4;

export class SlimExit extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "SlimExit";
    this.code = code;
  }
}
