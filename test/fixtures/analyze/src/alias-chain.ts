import { get } from "lodash";
const a = get;
const b = a;
export const v = b({ a: 1 }, "a");
