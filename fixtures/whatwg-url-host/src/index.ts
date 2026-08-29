import whatwg, { URL, URLSearchParams } from "whatwg-url";

export function host(href: string): string {
  return new URL(href).hostname;
}

export function query(href: string): string {
  return new URLSearchParams(new URL(href).search).get("q") ?? "";
}

export function viaDefault(href: string): string {
  return new whatwg.URL(href).hostname;
}
