import { lookup } from "mime-types";

export function typeOf(path: string): string | false {
  return lookup(path);
}
