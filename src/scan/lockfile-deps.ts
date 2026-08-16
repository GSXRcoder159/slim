import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../project.ts";

/** Direct dependency name → exact lockfile version. */
export function lockfileDirectDeps(
  root: string,
  kind: Project["lockfile"],
): Map<string, string> {
  if (kind === "npm") return parseNpmLock(join(root, "package-lock.json"));
  if (kind === "pnpm") return parsePnpmLock(join(root, "pnpm-lock.yaml"));
  if (kind === "yarn") return parseYarnLock(join(root, "yarn.lock"));
  if (kind === "bun") {
    const text = join(root, "bun.lock");
    const bin = join(root, "bun.lockb");
    if (existsSync(text)) return parseBunLock(text);
    if (existsSync(bin)) return parseBunLock(bin);
  }
  return new Map();
}

function parseNpmLock(path: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  let json: {
    lockfileVersion?: number;
    packages?: Record<string, { version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>;
    dependencies?: Record<string, { version?: string; dependencies?: Record<string, { version?: string }> }>;
  };
  try {
    json = JSON.parse(readFileSync(path, "utf8")) as typeof json;
  } catch {
    return out;
  }
  const pkgs = json.packages;
  if (pkgs) {
    const root = pkgs[""];
    const direct = {
      ...(root?.dependencies ?? {}),
      ...(root?.optionalDependencies ?? {}),
    };
    for (const name of Object.keys(direct)) {
      const rec = pkgs[`node_modules/${name}`];
      if (rec?.version) out.set(name, rec.version);
    }
    return out;
  }
  // ponytail: lockfileVersion 1 nests transitives; only take top-level keys
  if (json.dependencies) {
    for (const [name, rec] of Object.entries(json.dependencies)) {
      if (rec?.version) out.set(name, rec.version);
    }
  }
  return out;
}

function parsePnpmLock(path: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  const text = readFileSync(path, "utf8");
  // ponytail: no yaml parser; scan importers["."] dependencies block
  const importer = text.match(
    /(?:^|\n)importers:\n {2}\.:\n([\s\S]*?)(?=\n(?:packages|snapshots|time|overrides):|\n[^\s]|$)/,
  );
  const block = importer?.[1] ?? "";
  const depSection = block.match(
    /(?:^|\n) {4}(?:dependencies|optionalDependencies):\n([\s\S]*?)(?=\n {4}\w|\n {2}\S|$)/g,
  );
  if (depSection) {
    for (const sec of depSection) {
      const re = /(?:^|\n) {6}(\S+):\n(?: {8}.*\n)*? {8}version: ['"]?([^'"\n ]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sec))) {
        out.set(m[1]!, stripPnpmPeer(m[2]!));
      }
    }
  }
  if (out.size) return out;
  // fallback: packages: /lodash@4.17.21:  (only if also listed as a specifier near top)
  const names = new Set<string>();
  const specRe = /\n {6}(@?[\w.-]+(?:\/[\w.-]+)?):\n {8}specifier:/g;
  let sm: RegExpExecArray | null;
  const head = text.slice(0, 8000);
  while ((sm = specRe.exec(head))) names.add(sm[1]!);
  const pkgRe = /\n {2}(?:['"]?)(?:\/)?(@?[\w.-]+(?:\/[\w.-]+)?)@([^'"\s:(]+)/g;
  let pm: RegExpExecArray | null;
  while ((pm = pkgRe.exec(text))) {
    const name = pm[1]!;
    if (names.size === 0 || names.has(name)) out.set(name, stripPnpmPeer(pm[2]!));
  }
  return out;
}

function stripPnpmPeer(v: string): string {
  return v.replace(/\(.+$/, "").replace(/^['"]|['"]$/g, "");
}

function parseYarnLock(path: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  const text = readFileSync(path, "utf8");
  // ponytail: yarn.lock is not JSON; key lines name@version, then version "x"
  const blocks = text.split(/\n(?=\S)/);
  for (const block of blocks) {
    const key = block.match(/^"?(@?[^@\s"v][^@\s"]*?)@/);
    const ver = block.match(/\n {2}version "?([^"\n]+)"?/);
    if (key && ver) out.set(key[1]!, ver[1]!);
  }
  return out;
}

function parseBunLock(path: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  try {
    const json = JSON.parse(text) as {
      packages?: Record<string, unknown>;
    };
    if (json.packages && typeof json.packages === "object") {
      for (const [name, rec] of Object.entries(json.packages)) {
        if (name.includes("/") && !name.startsWith("@")) continue;
        const ver = bunVersion(rec);
        if (ver) out.set(name.startsWith("@") ? name : name.split("/")[0]!, ver);
      }
    }
  } catch {
    // ponytail: bun.lockb is binary; text bun.lock JSON-with-comments
    const re = /"(@?[\w.-]+(?:\/[\w.-]+)?)"\s*:\s*\[\s*"\1@([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.set(m[1]!, m[2]!);
  }
  return out;
}

function bunVersion(rec: unknown): string | undefined {
  if (Array.isArray(rec) && typeof rec[0] === "string") {
    const m = rec[0].match(/@([^@]+)$/);
    return m?.[1];
  }
  if (rec && typeof rec === "object" && "version" in rec && typeof (rec as { version: unknown }).version === "string") {
    return (rec as { version: string }).version;
  }
  return undefined;
}
