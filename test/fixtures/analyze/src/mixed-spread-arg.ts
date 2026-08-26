import { get } from "lodash";
const extra: object = { x: 1 };
export const v = get({ a: 1 }, "a", { a: 1, ...extra });
