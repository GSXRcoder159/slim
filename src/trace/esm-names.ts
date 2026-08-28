import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type ExtractEsmOpts = {
  parentUrl?: string;
  read?: (url: string) => string | null;
  seen?: Set<string>;
  onUnresolvedStar?: (spec: string) => void;
};

export function extractEsmExportNames(source: string, opts?: ExtractEsmOpts): string[] {
  const names = new Set<string>();
  const seen = opts?.seen ?? new Set<string>();
  if (opts?.parentUrl) {
    if (seen.has(opts.parentUrl)) return [];
    seen.add(opts.parentUrl);
  }

  if (/\bexport\s+default\b/.test(source)) names.add("default");
  for (const m of source.matchAll(
    /\bexport\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    if (m[1]) names.add(m[1]);
  }
  for (const m of source.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    if (m[1]) names.add(m[1]);
  }
  for (const m of source.matchAll(/\bexport\s+(type\s+)?\{([^}]+)\}/g)) {
    if (m[1]) continue;
    const body = m[2] ?? "";
    for (const part of body.split(",")) {
      const bits = part.trim();
      if (!bits) continue;
      const asMatch = bits.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/);
      const name = asMatch?.[1] ?? bits.split(/\s+/)[0];
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  for (const m of source.matchAll(
    /\bexport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g,
  )) {
    if (m[1]) names.add(m[1]);
  }
  for (const m of source.matchAll(/\bexport\s+\*\s+from\s+["']([^"']+)["']/g)) {
    const spec = m[1]!;
    const child = resolveStarTarget(spec, opts);
    if (!child) {
      opts?.onUnresolvedStar?.(spec);
      continue;
    }
    for (const n of extractEsmExportNames(child.source, {
      ...opts,
      parentUrl: child.url,
      seen,
    })) {
      if (n !== "default") names.add(n);
    }
    for (const n of extractCjsExportNames(child.source)) names.add(n);
  }
  return [...names];
}

export function extractCjsExportNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/\bexports\.([A-Za-z_$][\w$]*)\s*=/g)) {
    if (m[1]) names.add(m[1]);
  }
  for (const m of source.matchAll(/\bmodule\.exports\.([A-Za-z_$][\w$]*)\s*=/g)) {
    if (m[1]) names.add(m[1]);
  }
  return [...names];
}

function resolveStarTarget(
  spec: string,
  opts?: ExtractEsmOpts,
): { url: string; source: string } | null {
  if (!opts?.parentUrl) return null;
  if (!(spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("file:"))) return null;
  let url: string;
  try {
    url = stripQuery(new URL(spec, opts.parentUrl).href);
  } catch {
    return null;
  }
  const source = readModule(url, opts);
  if (source == null) return null;
  return { url, source };
}

function readModule(url: string, opts?: ExtractEsmOpts): string | null {
  if (opts?.read) return opts.read(url);
  try {
    return readFileSync(fileURLToPath(url), "utf8");
  } catch {
    return null;
  }
}

function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}
