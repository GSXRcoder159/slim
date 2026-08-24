import get from "lodash/get";
import lodashGet from "lodash.get";
export const a = get({ a: 1 }, "a");
export const b = lodashGet({ a: 1 }, "a");
