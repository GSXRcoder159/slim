/**
 * MIT License
 *
 * Native `Promise` with the Bluebird statics commonly used at call sites:
 * resolve, reject, all, race, delay, promisify.
 *
 * This is not Bluebird. There is no cancellation, promisifyAll, coroutine,
 * or Promise.map. `delay` looks up `setTimeout` at call time so a fake clock
 * can intercept it.
 */

type NodeCallback<T> = (err: unknown, result?: T) => void;
type NodeStyleFn = (this: unknown, ...args: never[]) => unknown;

export function resolve<T>(value: T | PromiseLike<T>): Promise<T> {
  return globalThis.Promise.resolve(value);
}

export function reject<T = never>(reason?: unknown): Promise<T> {
  return globalThis.Promise.reject(reason);
}

export function all<T>(values: Iterable<T | PromiseLike<T>>): Promise<Awaited<T>[]> {
  return globalThis.Promise.all(values);
}

export function race<T>(values: Iterable<T | PromiseLike<T>>): Promise<Awaited<T>> {
  return globalThis.Promise.race(values);
}

export function delay<T = void>(ms: number, value?: T): Promise<T> {
  const schedule = globalThis.setTimeout;
  return new globalThis.Promise((res) => {
    schedule(() => res(value as T), ms);
  });
}

export function promisify<T = unknown>(
  fn: (this: unknown, ...args: never[]) => unknown,
): (this: unknown, ...args: unknown[]) => Promise<T> {
  if (typeof fn !== "function") {
    throw new TypeError("Bluebird.promisify: expected a function");
  }
  return function promisified(this: unknown, ...args: unknown[]): Promise<T> {
    return new globalThis.Promise((res, rej) => {
      const cb: NodeCallback<T> = (err, result) => {
        if (err) rej(err);
        else res(result as T);
      };
      (fn as NodeStyleFn).apply(this, [...args, cb] as never[]);
    });
  };
}

export class Promise<T> extends globalThis.Promise<T> {
  static delay = delay;
  static promisify = promisify;
}

export default Promise;
