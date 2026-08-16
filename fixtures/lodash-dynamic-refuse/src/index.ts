import _ from "lodash";

export function call(name: string, obj: object): unknown {
  return (_ as unknown as Record<string, (o: object) => unknown>)[name](obj);
}
