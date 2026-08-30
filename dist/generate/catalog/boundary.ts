import type { ArgShape, Envelope } from "../../envelope/types.ts";
import { formatRefuse, type RefuseReason } from "../../scan/refuse.ts";
import { catalogSymbols, canonicalCatalogPkg, matchCatalog } from "./index.ts";
import { canonicalLodashSymbol } from "./lodash-names.ts";
import { MIME_EXTENSION_TYPES, MIME_LOOKUP_EXTS } from "./mimeTypes.ts";

const CATALOG_FAMILIES = new Set([
  "lodash",
  "moment",
  "uuid",
  "ms",
  "nanoid",
  "clsx",
  "whatwg-url",
  "bluebird",
  "mime-types",
]);

const MOMENT_METHODS = new Set([
  "format",
  "unix",
  "valueOf",
  "toDate",
  "add",
  "subtract",
  "isValid",
]);

const IGNORED_EXPORTS = new Set(["*", "default", "(scan)"]);

export function catalogBoundary(env: Envelope, pkg: string): RefuseReason | null {
  const family = canonicalCatalogPkg(pkg);
  if (!CATALOG_FAMILIES.has(family)) return null;

  if (pkg.startsWith("lodash.")) {
    const suffix = pkg.slice("lodash.".length);
    if (!canonicalLodashSymbol(suffix)) {
      return tooWide(
        pkg,
        family,
        `package ${pkg}`,
        `blocking: ${pkg} is not a registered lodash.* alias`,
      );
    }
  }

  const used = env.symbols
    .map((s) => s.exportName)
    .filter((n) => !IGNORED_EXPORTS.has(n));
  const { missing } = matchCatalog(pkg, used);
  if (missing.length) {
    return tooWide(pkg, family, `exports used: ${used.join(", ")}`, `blocking: ${missing.join(", ")}`);
  }

  if (family === "moment") {
    const members = resultMembers(env).filter((m) => !MOMENT_METHODS.has(m));
    if (members.length) {
      return tooWide(
        pkg,
        family,
        `result members: ${resultMembers(env).join(", ") || "(none)"}`,
        `blocking: ${members.join(", ")}`,
      );
    }
  }

  if (family === "mime-types") {
    const extra = mimeExtras(env);
    if (extra.length) {
      return tooWide(pkg, family, `types/paths: ${extra.join(", ")}`, `blocking: not in v1 MIME allowlist`);
    }
  }

  return null;
}

export function formatCatalogRefuse(r: RefuseReason): string {
  return formatRefuse(r);
}

function tooWide(pkg: string, family: string, evidence: string, blocking: string): RefuseReason {
  const allowed = catalogSymbols(pkg).filter((s) => s !== "default").join(", ");
  return {
    pkg,
    why: "envelope-too-wide",
    evidence: `${evidence}\n  ${blocking}\n  v1 ${family} slice: ${allowed}`,
    whatToDo: `Stop using the blocking APIs, then re-run: slim replace ${pkg}\n  Or keep ${pkg}`,
  };
}

function resultMembers(env: Envelope): string[] {
  const out = new Set<string>();
  for (const s of env.symbols) {
    for (const m of s.resultMembers) out.add(m);
    for (const c of s.callSites) {
      for (const m of c.resultMembers) out.add(m);
    }
  }
  return [...out];
}

function mimeExtras(env: Envelope): string[] {
  const extra: string[] = [];
  for (const s of env.symbols) {
    const names = new Set([s.exportName, ...s.callSites.map((c) => c.exportName)]);
    for (const site of s.callSites) {
      for (const lit of shapeStrings(site.argShapes[0])) {
        if (names.has("lookup") || s.exportName === "lookup") {
          const ext = extOf(lit);
          if (ext && !MIME_LOOKUP_EXTS.has(ext)) extra.push(lit);
        }
        if (names.has("extension") || s.exportName === "extension") {
          const media = lit.split(";", 1)[0]!.trim().toLowerCase();
          if (media && !MIME_EXTENSION_TYPES.has(media)) extra.push(lit);
        }
      }
    }
  }
  return [...new Set(extra)];
}

function shapeStrings(shape: ArgShape | undefined): string[] {
  if (!shape) return [];
  const out: string[] = [];
  if (shape.literals) {
    for (const v of shape.literals) if (typeof v === "string") out.push(v);
  }
  if (shape.elements) {
    for (const el of shape.elements) out.push(...shapeStrings(el));
  }
  if (shape.props) {
    for (const el of Object.values(shape.props)) out.push(...shapeStrings(el));
  }
  return out;
}

function extOf(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot === -1) return base.toLowerCase();
  return base.slice(dot + 1).toLowerCase();
}
