import { isBuiltin } from "node:module";

export interface PackageFamily {
  name: string;
  family: string;
  subpath: string;
}

const FAMILY_ALIAS: Record<string, string> = {
  lodash: "lodash",
  "lodash-es": "lodash",
  underscore: "lodash",
  moment: "moment",
  uuid: "uuid",
  ms: "ms",
  nanoid: "nanoid",
  clsx: "clsx",
  classnames: "clsx",
  "whatwg-url": "whatwg-url",
  "url-parse": "whatwg-url",
  bluebird: "bluebird",
  "mime-types": "mime-types",
  "mime-db": "mime-types",
  mime: "mime-types",
  "query-string": "qs",
  qs: "qs",
};

const PROTOCOL = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WINDOWS_ABS = /^[a-zA-Z]:[\\/]/;

export function parseSpecifier(specifier: string): {
  name: string;
  subpath: string;
} | null {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) {
    return null;
  }
  if (specifier.startsWith("#")) return null;
  if (WINDOWS_ABS.test(specifier)) return null;
  if (PROTOCOL.test(specifier)) return null;
  if (isBuiltin(specifier) || isBuiltin(`node:${specifier}`)) return null;
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    if (parts.length < 2) return null;
    const name = `${parts[0]}/${parts[1]}`;
    if (isBuiltin(name)) return null;
    const rest = parts.slice(2).join("/");
    return { name, subpath: rest.replace(/\.js$/, "") };
  }
  const slash = specifier.indexOf("/");
  const name = slash === -1 ? specifier : specifier.slice(0, slash);
  if (isBuiltin(name) || isBuiltin(`node:${name}`)) return null;
  if (slash === -1) return { name, subpath: "" };
  return {
    name,
    subpath: specifier.slice(slash + 1).replace(/\.js$/, ""),
  };
}

export function resolvePackageImports(
  specifier: string,
  importMap: unknown,
): string | null {
  if (!specifier.startsWith("#")) return specifier;
  if (!importMap || typeof importMap !== "object") return null;
  const rec = importMap as Record<string, unknown>;
  const raw = rec[specifier];
  const target =
    typeof raw === "string"
      ? raw
      : raw && typeof raw === "object" && typeof (raw as { default?: unknown }).default === "string"
        ? (raw as { default: string }).default
        : null;
  if (!target) return null;
  return parseSpecifier(target) ? target : null;
}

export function resolvePackageFamily(specifier: string): PackageFamily | null {
  const parsed = parseSpecifier(specifier);
  if (!parsed) return null;
  let { name, subpath } = parsed;
  if (name.startsWith("lodash.") && name !== "lodash") {
    subpath = name.slice("lodash.".length);
    name = "lodash";
  }
  const family = FAMILY_ALIAS[name] ?? name;
  return { name: parsed.name, family, subpath };
}

export function installedVersion(
  deps: Record<string, string> | undefined,
  name: string,
): string {
  const raw = deps?.[name] ?? "";
  return raw.replace(/^[~^>=<\s]+/, "") || "unknown";
}
