import { extension, lookup } from "mime-types";

export function typeOf(path: string): string | false {
  return lookup(path);
}

export function extOf(type: string): string | false {
  return extension(type);
}
