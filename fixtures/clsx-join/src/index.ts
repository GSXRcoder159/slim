import clsxDefault, { clsx } from "clsx";

export function classes(active: boolean): string {
  return clsx("btn", { "btn-active": active }, ["px-2"]);
}

export function classesDefault(active: boolean): string {
  return clsxDefault("btn", active && "on");
}
