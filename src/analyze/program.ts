import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type ts from "typescript";
import type { Project } from "../project.ts";
import { parseSpecifier } from "./family.ts";
import type { ProgramCtx } from "./model.ts";

export function readTsConfig(
  ts: typeof import("typescript"),
  project: Project,
): ts.ParsedCommandLine | null {
  if (!project.tsconfigPath) return null;
  const { config, error } = ts.readConfigFile(project.tsconfigPath, (p) => ts.sys.readFile(p));
  if (error || !config) return null;
  return ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    dirname(project.tsconfigPath),
    undefined,
    project.tsconfigPath,
  );
}

// ponytail: Program is opt-in (paths / exports / literal unions); do not typecheck unused packages
export function shouldEscalate(
  ts: typeof import("typescript"),
  project: Project,
  files: string[],
  getSf: (f: string) => ts.SourceFile,
  parsed: ts.ParsedCommandLine | null,
): boolean {
  if (parsed?.options.paths && Object.keys(parsed.options.paths).length) return true;
  for (const file of files) {
    const sf = getSf(file);
    let hit = false;
    const visit = (n: ts.Node) => {
      if (ts.isUnionTypeNode(n) && n.types.some((t) => ts.isLiteralTypeNode(t))) hit = true;
      if (n.kind === ts.SyntaxKind.AnyKeyword) hit = true;
      if (ts.isImportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        const spec = n.moduleSpecifier.text;
        if (spec.startsWith("#")) hit = true;
        if (packageExportsNeeded(project.root, spec)) hit = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (hit) return true;
  }
  return false;
}

function packageExportsNeeded(root: string, spec: string): boolean {
  const parsed = parseSpecifier(spec);
  if (!parsed?.subpath) return false;
  const pj = join(root, "node_modules", parsed.name, "package.json");
  if (!existsSync(pj)) return false;
  try {
    return Boolean(
      (JSON.parse(readFileSync(pj, "utf8")) as { exports?: unknown }).exports,
    );
  } catch {
    return false;
  }
}

export function createScopedProgram(
  ts: typeof import("typescript"),
  project: Project,
  files: string[],
  parsed: ts.ParsedCommandLine | null,
): ProgramCtx {
  const options: ts.CompilerOptions = {
    ...(parsed?.options ?? {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowJs: true,
      baseUrl: project.root,
    }),
    noEmit: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options, true);
  const program = ts.createProgram(files, options, host);
  return { program, checker: program.getTypeChecker(), options, host };
}
