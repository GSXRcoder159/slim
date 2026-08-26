import { get } from "lodash";
const fn = get;
export const v = fn({ a: 1 }, "a");
