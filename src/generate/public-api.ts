import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathEscapesRoot, toPosixPath } from "../rewrite/paths.ts";
import { EXIT_FAIL, SlimExit } from "../exit.ts";
import {
  OriginalSourceGuard,
  assertDeclaredSpecInside,
  assertPublicSpecInside,
} from "./guard.ts";

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
  const nodeModules = resolve(projectRoot, "node_modules");
  const dir = assertInsideNodeModules(projectRoot, nodeModules, packageDir(projectRoot, pkg));
  const meta = readPackageJson(dir);

  if (subpath) {
    const subRel =
      typesFromExports(meta?.exports, `./${subpath}`) ??
      typesFromExports(meta?.exports, subpath);
    const subAbs = firstDts(
      dir,
      subRel,
      join(dir, `${subpath}.d.ts`),
    );
    if (subAbs) return specFromDts(projectRoot, subAbs, "subpath-dts");
  }

  const rootRel =
    typesFromExports(meta?.exports, ".") ??
    (typeof meta?.types === "string" ? meta.types : undefined) ??
    (typeof meta?.typings === "string" ? meta.typings : undefined);
  const bundled = firstDts(
    dir,
    rootRel,
    join(dir, "index.d.ts"),
    join(dir, `${bareName(pkg)}.d.ts`),
  );
  if (bundled) return specFromDts(projectRoot, bundled, "bundled-dts");

  const typesDir = packageDir(projectRoot, typesPackageName(pkg));
  if (existsSync(typesDir)) {
    const typesRoot = assertInsideNodeModules(projectRoot, nodeModules, typesDir);
    const dt = firstDts(typesRoot, undefined, join(typesRoot, "index.d.ts"), join(typesRoot, `${bareName(pkg)}.d.ts`));
    if (dt) return specFromDts(projectRoot, dt, "types-package");
  }

  const readme = firstExisting(dir, join(dir, "README.md"), join(dir, "README"));
  if (readme) {
    const raw = OriginalSourceGuard.readPublicSpec(readme);
    const truncated = raw.length > README_CAP;
    const text = raw.slice(0, README_CAP);
    return {
      text,
      source: "readme",
      from: toPosixPath(relative(projectRoot, readme)),
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
    from: toPosixPath(relative(projectRoot, abs)),
  };
}

function assertInsideNodeModules(projectRoot: string, nodeModules: string, dir: string): string {
  const abs = resolve(dir);
  const relNm = relative(resolve(nodeModules), abs);
  if (relNm.startsWith("..") || relNm === ".." || isAbsolute(relNm) || relNm === "") {
    throw new SlimExit(EXIT_FAIL, `public spec escapes package root: ${dir}`);
  }
  if (pathEscapesRoot(projectRoot, abs)) {
    throw new SlimExit(EXIT_FAIL, `public spec escapes package root: ${dir}`);
  }
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function packageDir(projectRoot: string, pkg: string): string {
  const parts = pkg.split("/");
  if (parts.some((p) => p === ".." || p === "." || p === "" || isAbsolute(p))) {
    throw new SlimExit(EXIT_FAIL, `public spec escapes package root: ${pkg}`);
  }
  return join(projectRoot, "node_modules", ...parts);
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
  assertPublicSpecInside(dir, p);
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

/**
 * `declaredRel` is package.json metadata: escaping it is a hard refuse.
 * Later `candidates` are discovered files: missing is skip, present-but-escaping is refuse.
 */
function firstDts(
  packageRoot: string,
  declaredRel: string | undefined,
  ...candidates: Array<string | undefined>
): string | undefined {
  if (declaredRel) {
    const abs = assertDeclaredSpecInside(packageRoot, declaredRel);
    if (abs.endsWith(".d.ts") && existsSync(abs)) {
      OriginalSourceGuard.assertNotOriginalImpl(abs);
      assertPublicSpecInside(packageRoot, abs);
      return abs;
    }
  }
  for (const p of candidates) {
    if (!p || !p.endsWith(".d.ts") || !existsSync(p)) continue;
    OriginalSourceGuard.assertNotOriginalImpl(p);
    assertPublicSpecInside(packageRoot, p);
    return p;
  }
  return undefined;
}

function firstExisting(packageRoot: string, ...paths: string[]): string | undefined {
  for (const p of paths) {
    if (!existsSync(p)) continue;
    assertPublicSpecInside(packageRoot, p);
    return p;
  }
  return undefined;
}

export { readFileSync };
