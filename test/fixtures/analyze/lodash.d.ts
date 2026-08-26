declare module "lodash" {
  export interface Dictionary<T> {
    [index: string]: T;
  }
  export function get(object: object, path: string | readonly unknown[], defaultValue?: unknown): unknown;
  export function debounce<T extends (...args: never[]) => unknown>(
    fn: T,
    wait?: number,
  ): T & { cancel(): void; flush(): void };
  const lodash: { get: typeof get; debounce: typeof debounce };
  export default lodash;
}
declare module "lodash-es" {
  export function get(object: object, path: string | readonly unknown[], defaultValue?: unknown): unknown;
  export function debounce<T extends (...args: never[]) => unknown>(
    fn: T,
    wait?: number,
  ): T & { cancel(): void; flush(): void };
}
declare module "lodash/get" {
  function get(object: object, path: string | readonly unknown[], defaultValue?: unknown): unknown;
  export default get;
}
declare module "lodash.get" {
  function get(object: object, path: string | readonly unknown[], defaultValue?: unknown): unknown;
  export default get;
}
