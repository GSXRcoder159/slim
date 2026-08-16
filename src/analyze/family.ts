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
  "query-string": "qs",
  qs: "qs",
};

export function parseSpecifier(specifier: string): {
  name: string;
  subpath: string;
} | null {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) {
    return null;
  }
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) return null;
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    if (parts.length < 2) return null;
    const name = `${parts[0]}/${parts[1]}`;
    const rest = parts.slice(2).join("/");
    return { name, subpath: rest.replace(/\.js$/, "") };
  }
  const slash = specifier.indexOf("/");
  if (slash === -1) return { name: specifier, subpath: "" };
  return {
    name: specifier.slice(0, slash),
    subpath: specifier.slice(slash + 1).replace(/\.js$/, ""),
  };
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
