import _ from "lodash";
export function f(k: string) {
  return (_ as any)[k]({});
}
