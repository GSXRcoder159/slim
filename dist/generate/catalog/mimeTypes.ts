/**
 * MIT License
 *
 * Original Slim MIME map for the common web types a typical envelope needs.
 * Not the mime-db encyclopedia; unknown types return false.
 */
// ponytail: envelope-driven mime-db later

const EXT_TO_TYPE: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  woff: "font/woff",
  woff2: "font/woff2",
  wasm: "application/wasm",
  txt: "text/plain",
  xml: "application/xml",
  pdf: "application/pdf",
};

const TYPE_TO_EXT: Record<string, string> = {
  "text/html": "html",
  "text/css": "css",
  "application/javascript": "js",
  "application/json": "json",
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "font/woff": "woff",
  "font/woff2": "woff2",
  "application/wasm": "wasm",
  "text/plain": "txt",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/pdf": "pdf",
};

export const MIME_LOOKUP_EXTS = new Set(Object.keys(EXT_TO_TYPE));
export const MIME_EXTENSION_TYPES = new Set(Object.keys(TYPE_TO_EXT));

function extensionOf(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot === -1) return base.toLowerCase();
  return base.slice(dot + 1).toLowerCase();
}

export function lookup(path: unknown): string | false {
  if (typeof path !== "string" || path.length === 0) return false;
  const ext = extensionOf(path);
  if (!ext) return false;
  return EXT_TO_TYPE[ext] ?? false;
}

export function extension(type: unknown): string | false {
  if (typeof type !== "string" || type.length === 0) return false;
  const media = type.split(";", 1)[0]!.trim().toLowerCase();
  return TYPE_TO_EXT[media] ?? false;
}
