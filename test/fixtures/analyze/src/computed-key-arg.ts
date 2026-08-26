import { get } from "lodash";
export function f(k: string) {
  return get({ a: 1 }, "a", { [k]: 1 });
}
