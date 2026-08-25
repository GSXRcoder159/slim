import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { OriginalSourceGuard } from "./guard.ts";

export type SpecSource =
  | "bundled-dts"
  | "types-package"
  | "subpath-dts"
  | "readme"
  | "envelope-only";

export interface PublicApiSpec {
  text: string;
  source: SpecSource;
  from?: string;
  limitation?: string;
}

const README_CAP = 8000;

export function loadPublicApi(projectRoot: string, pkg: string, subpath = ""): PublicApiSpec {
  const dir = packageDir(projectRoot, pkg);
  const meta = readPackageJson(dir);

  if (subpath) {
    const subRel =
      typesFromExports(meta?.exports, `./${subpath}`) ??
      typesFromExports(meta?.exports, subpath);
    const subAbs = firstDts(
      subRel ? join(dir, subRel) : undefined,
      join(dir, `${subpath}.d.ts`),
    );
    if (subAbs) return specFromDts(projectRoot, subAbs, "subpath-dts");
  }

  const rootRel =
    typesFromExports(meta?.exports, ".") ??
    (typeof meta?.types === "string" ? meta.types : undefined) ??
    (typeof meta?.typings === "string" ? meta.typings : undefined);
  const bundled = firstDts(
    rootRel ? join(dir, rootRel) : undefined,
    join(dir, "index.d.ts"),
    join(dir, `${bareName(pkg)}.d.ts`),
  );
  if (bundled) return specFromDts(projectRoot, bundled, "bundled-dts");

  const typesDir = packageDir(projectRoot, typesPackageName(pkg));
  const dt = firstDts(join(typesDir, "index.d.ts"), join(typesDir, `${bareName(pkg)}.d.ts`));
  if (dt) return specFromDts(projectRoot, dt, "types-package");

  const readme = firstExisting(join(dir, "README.md"), join(dir, "README"));
  if (readme) {
    const raw = OriginalSourceGuard.readPublicSpec(readme);
    const truncated = raw.length > README_CAP;
    const text = raw.slice(0, README_CAP);
    return {
      text,
      source: "readme",
      from: relative(projectRoot, readme),
      ...(truncated
        ? { limitation: `README truncated to ${README_CAP} characters.` }
        : {}),
    };
  }

  const limitation =
    `package ${pkg} — no local .d.ts or README; implement from envelope call sites only. Do not invent undocumented overloads.`;
  return { text: limitation, source: "envelope-only", limitation };
}

function specFromDts(projectRoot: string, abs: string, source: SpecSource): PublicApiSpec {
  return {
    text: OriginalSourceGuard.readPublicSpec(abs),
    source,
    from: relative(projectRoot, abs),
  };
}

function packageDir(projectRoot: string, pkg: string): string {
  return join(projectRoot, "node_modules", ...pkg.split("/"));
}

function typesPackageName(pkg: string): string {
  if (pkg.startsWith("@")) {
    const [scope, name] = pkg.slice(1).split("/");
    if (scope && name) return `@types/${scope}__${name}`;
  }
  return `@types/${pkg}`;
}

function bareName(pkg: string): string {
  const parts = pkg.split("/");
  return parts[parts.length - 1] ?? pkg;
}

function readPackageJson(dir: string): Record<string, unknown> | null {
  const p = join(dir, "package.json");
  if (!existsSync(p)) return null;
  OriginalSourceGuard.assertNotOriginalImpl(p);
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function typesFromExports(exportsField: unknown, key: string): string | undefined {
  if (exportsField == null) return undefined;
  if (key === "." && typeof exportsField === "string") return dtsOnly(exportsField);
  if (typeof exportsField !== "object" || Array.isArray(exportsField)) return undefined;
  const entry = (exportsField as Record<string, unknown>)[key];
  return dtsOnly(typesFromCondition(entry));
}

function typesFromCondition(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const t = typesFromCondition(v);
      if (t) return t;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return (
      typesFromCondition(o.types) ??
      typesFromCondition(o.import) ??
      typesFromCondition(o.default) ??
      typesFromCondition(o.require)
    );
  }
  return undefined;
}

function dtsOnly(rel: string | undefined): string | undefined {
  if (!rel) return undefined;
  const clean = rel.split("?")[0]!.replace(/^\.\//, "");
  return clean.endsWith(".d.ts") ? rel : undefined;
}

function firstDts(...paths: Array<string | undefined>): string | undefined {
  for (const p of paths) {
    if (p && p.endsWith(".d.ts") && existsSync(p)) {
      OriginalSourceGuard.assertNotOriginalImpl(p);
      return p;
    }
  }
  return undefined;
}

function firstExisting(...paths: string[]): string | undefined {
  return paths.find((p) => existsSync(p));
}

export { readFileSync };
