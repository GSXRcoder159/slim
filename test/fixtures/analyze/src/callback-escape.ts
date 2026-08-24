import { get } from "lodash";
export const xs = ([{ a: 1 }] as object[]).map(get as (value: object) => unknown);
