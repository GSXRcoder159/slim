declare function require(id: string): unknown;
export function f(x: string) {
  return require(x);
}
