import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { siblingModule } from "../runtime-path.ts";
import { registerHooks } from "node:module";
import type { TraceEvent } from "../envelope/types.ts";
import { wrapExports } from "./proxy.ts";

type LoadResult = {
  format?: string | null;
  source?: string | ArrayBuffer | Uint8Array | null;
  shortCircuit?: boolean;
};

type LoadContext = {
  format?: string | null;
  importAttributes?: Record<string, string>;
};

type NextLoad = (url: string, context?: LoadContext) => LoadResult;

type SlimGlobal = typeof globalThis & {
  __slimTraceOnEvent?: (e: TraceEvent) => void;
  __slimWrapExports?: typeof wrapExports;
};

function slimGlobal(): SlimGlobal {
  return globalThis as SlimGlobal;
}

export function matchesTracedUrl(url: string, packages: string[]): boolean {
  let pathname = url;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    /* keep raw */
  }
  const sorted = [...packages].sort((a, b) => b.length - a.length);
  for (const pkg of sorted) {
    const needle = `/node_modules/${pkg}`;
    const idx = pathname.indexOf(needle);
    if (idx === -1) continue;
    const after = pathname.slice(idx + needle.length);
    if (after === "" || after.startsWith("/") || after.startsWith(".")) return true;
  }
  return false;
}

export function packageFromUrl(url: string, packages: string[]): string | null {
  const sorted = [...packages].sort((a, b) => b.length - a.length);
  for (const pkg of sorted) {
    if (matchesTracedUrl(url, [pkg])) return pkg;
  }
  return null;
}

function packagesFromEnv(): string[] {
  return (process.env.SLIM_TRACE_PACKAGES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function hasSlimOrig(url: string): boolean {
  try {
    return new URL(url).searchParams.has("slim-orig");
  } catch {
    return url.includes("slim-orig");
  }
}

function addSlimOrig(url: string): string {
  const u = new URL(url);
  u.searchParams.set("slim-orig", "1");
  return u.href;
}

function stripSlimOrig(url: string): string {
  const u = new URL(url);
  u.searchParams.delete("slim-orig");
  return u.href;
}

function sourceToString(source: LoadResult["source"], url: string): string {
  if (typeof source === "string") return source;
  if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
  if (source instanceof ArrayBuffer) return Buffer.from(source).toString("utf8");
  try {
    const clean = stripQuery(url);
    if (clean.startsWith("file:")) return readFileSync(fileURLToPath(clean), "utf8");
  } catch {
    /* ignore */
  }
  return "";
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

function siblingHref(name: string): string {
  return pathToFileURL(siblingModule(import.meta.url, name)).href;
}

function extractEsmExportNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(
    /\bexport\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    if (m[1]) names.add(m[1]);
  }
  for (const m of source.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    if (m[1]) names.add(m[1]);
  }
  for (const m of source.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    const body = m[1] ?? "";
    for (const part of body.split(",")) {
      const bits = part.trim();
      if (!bits || bits === "default") continue;
      const asMatch = bits.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/);
      const name = asMatch?.[1] ?? bits.split(/\s+/)[0];
      if (name && name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

function cjsTrailer(packageName: string): string {
  return `

;(() => {
  const g = globalThis;
  if (typeof g.__slimWrapExports === "function") {
    module.exports = g.__slimWrapExports(module.exports, {
      packageName: ${JSON.stringify(packageName)},
      onEvent: (e) => { if (typeof g.__slimTraceOnEvent === "function") g.__slimTraceOnEvent(e); },
    });
  }
})();
`;
}

function esmWrapper(origUrl: string, names: string[], packageName: string): string {
  const named = names
    .filter((n) => n !== "default")
    .map((n) => `export const ${n} = __slim_wrapped[${JSON.stringify(n)}];`)
    .join("\n");
  return `import * as __slim_orig from ${JSON.stringify(origUrl)};
import { wrapExports } from ${JSON.stringify(siblingHref("proxy"))};

const __slim_wrapped = wrapExports(__slim_orig, {
  packageName: ${JSON.stringify(packageName)},
  onEvent: (e) => { globalThis.__slimTraceOnEvent && globalThis.__slimTraceOnEvent(e); },
});

export default __slim_wrapped.default !== undefined ? __slim_wrapped.default : __slim_wrapped;
${named}
`;
}

function isEsmFormat(format: string | null | undefined): boolean {
  return format === "module" || format === "module-typescript";
}

let hooksInstalled = false;
const tracedPackages: string[] = [];
const eventSinks: Array<(e: TraceEvent) => void> = [];
const flushers: Array<() => void> = [];

function dispatchEvent(e: TraceEvent): void {
  for (const sink of eventSinks) sink(e);
}

function loadHook(url: string, context: LoadContext, nextLoad: NextLoad): LoadResult {
  if (hasSlimOrig(url)) return nextLoad(stripSlimOrig(url), context);
  if (!matchesTracedUrl(url, tracedPackages)) return nextLoad(url, context);

  const pkg = packageFromUrl(url, tracedPackages) ?? tracedPackages[0] ?? "unknown";
  const result = nextLoad(url, context);
  const format = result.format ?? context.format;
  const pathForFormat = stripQuery(url);

  if (format === "json" || format === "builtin" || format === "wasm") return result;
  if (/\.json$/i.test(pathForFormat)) return result;

  if (isEsmFormat(format) || /\.m[jt]s$/i.test(pathForFormat)) {
    const names = extractEsmExportNames(sourceToString(result.source, url));
    return {
      format: "module",
      shortCircuit: true,
      source: esmWrapper(addSlimOrig(url), names, pkg),
    };
  }

  // CJS require() often yields format undefined with a source string (Node 22).
  const src = sourceToString(result.source, url);
  return {
    ...result,
    format: "commonjs",
    shortCircuit: true,
    source: src + cjsTrailer(pkg),
  };
}

function installHooks(): void {
  slimGlobal().__slimWrapExports = wrapExports;
  slimGlobal().__slimTraceOnEvent = dispatchEvent;
  if (hooksInstalled) return;
  hooksInstalled = true;
  registerHooks({
    load(url, context, nextLoad) {
      return loadHook(url, context as LoadContext, nextLoad as NextLoad) as ReturnType<typeof nextLoad>;
    },
  });
  process.on("beforeExit", () => {
    for (const f of flushers) {
      try {
        f();
      } catch {
        /* ignore */
      }
    }
  });
}

export function createSlimHooks(opts: {
  packages: string[];
  outPath?: string;
}): { register(): void; events(): TraceEvent[]; flush(): void } {
  const packages = opts.packages;
  const outPath = opts.outPath ?? process.env.SLIM_TRACE_OUT;
  const events: TraceEvent[] = [];

  function onEvent(e: TraceEvent): void {
    events.push(e);
    if (!outPath) return;
    mkdirSync(dirname(outPath), { recursive: true });
    appendFileSync(outPath, JSON.stringify(e) + "\n");
  }

  function flush(): void {
    if (!outPath) return;
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, events.map((e) => JSON.stringify(e) + "\n").join(""));
  }

  function register(): void {
    for (const pkg of packages) {
      if (!tracedPackages.includes(pkg)) tracedPackages.push(pkg);
    }
    if (!eventSinks.includes(onEvent)) eventSinks.push(onEvent);
    if (!flushers.includes(flush)) flushers.push(flush);
    installHooks();
  }

  return {
    register,
    events: () => events.slice(),
    flush,
  };
}

const envPackages = packagesFromEnv();
if (envPackages.length) {
  createSlimHooks({
    packages: envPackages,
    outPath: process.env.SLIM_TRACE_OUT,
  }).register();
}
