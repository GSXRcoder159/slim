import { get } from "./reexport";
import { debounce } from "./barrel";
export const a = get({ a: 1 }, "a");
export const d = debounce(() => {}, 5);
