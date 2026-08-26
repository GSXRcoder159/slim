import { get } from "lodash";
export const obj: { fn?: typeof get } = {};
obj.fn = get;
