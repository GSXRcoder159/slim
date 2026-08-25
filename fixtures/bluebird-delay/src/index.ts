import Bluebird from "bluebird";

export function ok(value: string): Promise<string> {
  return Bluebird.resolve(value);
}
