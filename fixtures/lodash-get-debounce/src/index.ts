import _ from "./slim/lodash.ts";

export function pickUser(user: { profile?: { name?: string | null } } | null): string {
  return _.get(user, "profile.name", "anonymous") as string;
}

export function nestedRef(obj: { a: { b: { c: number } } }) {
  return _.get(obj, "a.b");
}

export function nestedRefPath(obj: { a: { b: { c: number } } }) {
  return _.get(obj, ["a", "b"]);
}

export const ping = _.debounce((n: number) => n, 50);

export function schedule(fn: () => void): ReturnType<typeof _.debounce> {
  return _.debounce(fn, 25);
}

export function badDebounce(): ReturnType<typeof _.debounce> {
  return _.debounce(null as never, 10);
}
