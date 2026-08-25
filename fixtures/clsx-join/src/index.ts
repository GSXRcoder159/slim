import { clsx } from "clsx";

export function classes(active: boolean): string {
  return clsx("btn", { "btn-active": active }, ["px-2"]);
}
