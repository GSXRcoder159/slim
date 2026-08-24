import { get } from "lodash";
export const a = get.call(null, { a: 1 }, "a");
export const b = get.apply(null, [{ a: 1 }, "a"] as [object, string]);
export const c = get.bind(null, { a: 1 });
