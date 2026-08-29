import { customAlphabet, nanoid } from "nanoid";

export function shortId(): string {
  return nanoid(10);
}

export function defaultId(): string {
  return nanoid(8);
}

export function customId(): string {
  return customAlphabet("abc", 6)();
}
