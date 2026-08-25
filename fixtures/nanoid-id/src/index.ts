import { nanoid } from "nanoid";

export function shortId(): string {
  return nanoid(10);
}
