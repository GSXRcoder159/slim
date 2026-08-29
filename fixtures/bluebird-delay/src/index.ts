import Bluebird from "bluebird";

export function ok(value: string): Promise<string> {
  return Bluebird.resolve(value);
}

export function nope(reason: string): Promise<never> {
  return Bluebird.reject(new Error(reason));
}

export function both(a: string, b: string): Promise<string[]> {
  return Bluebird.all([ok(a), ok(b)]);
}

export function first(a: string, b: string): Promise<string> {
  return Bluebird.race([ok(a), ok(b)]);
}

export function later(value: string): Promise<string> {
  return Bluebird.delay(0, value);
}

export const readCb = Bluebird.promisify((cb: (err: Error | null, v?: number) => void) => cb(null, 7));

export function viaCtor(value: number): Promise<number> {
  return new Bluebird((res: (v: number) => void) => res(value));
}
