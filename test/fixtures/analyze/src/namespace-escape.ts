import * as _ from "lodash";
export const keys = Object.keys(_);
export function take(fn: (x: object) => void) {
  fn(_);
}
export const spread = { ..._ };
