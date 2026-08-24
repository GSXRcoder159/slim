import { debounce, get } from "lodash";
export const v = get({ a: 1 }, "a");
export const w = get({ a: 1 }, "a", [[1], [2]]);
export const d = debounce(() => {}, 10);
