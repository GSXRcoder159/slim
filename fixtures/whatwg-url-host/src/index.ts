import { URL } from "whatwg-url";

export function host(href: string): string {
  return new URL(href).hostname;
}
