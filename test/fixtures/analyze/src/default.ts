import _ from "lodash";
export const v = _.get({ a: 1 }, "a");
export const d = _.debounce(() => {}, 10);
