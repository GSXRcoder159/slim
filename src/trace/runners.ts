import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { vitestTraceConfigSource } from "./vitest.ts";

export { vitestTraceConfigSource };

export type RunnerKind = "node:test" | "vitest" | "jest" | "none";

export interface DetectedRunner {
  kind: RunnerKind;
  command: string | null;
  jestSnippet?: string;
}

const JEST_SNIPPET = `// Slim v1 does not wrap Jest.
// Use moduleNameMapper and setupFiles as a manual escape hatch:
//
//   moduleNameMapper: {
//     '^lodash$': '<rootDir>/node_modules/lodash/lodash.js',
//     '^lodash-es$': '<rootDir>/node_modules/lodash-es/index.js',
//   },
//   setupFiles: ['<rootDir>/slim-jest-setup.js'],
//
// Prefer node:test (--import slim/hooks) or Vitest with the slim/vitest
// plugin for automatic tracing.`;

export function detectRunner(projectRoot: string): DetectedRunner {
  let pkg: {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  try {
    pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as typeof pkg;
  } catch {
    return { kind: "none", command: null };
  }

  const scripts = pkg.scripts ?? {};
  const testScript = scripts.test ?? "";
  const scriptValues = Object.values(scripts);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  const has = (s: string, re: RegExp) => re.test(s);
  const anyScript = (re: RegExp) => scriptValues.some((s) => re.test(s));

  if (has(testScript, /\bvitest\b/) || anyScript(/\bvitest\b/)) {
    const fromOther = scriptValues.find((s) => /\bvitest\b/.test(s));
    return {
      kind: "vitest",
      command: has(testScript, /\bvitest\b/) ? testScript : (fromOther ?? "npx vitest run"),
    };
  }

  if (has(testScript, /\bjest\b/) || anyScript(/\bjest\b/)) {
    return { kind: "jest", command: null, jestSnippet: JEST_SNIPPET };
  }

  if (
    has(testScript, /--test\b/) ||
    has(testScript, /node:test/) ||
    anyScript(/--test\b/) ||
    anyScript(/node:test/)
  ) {
    const fromOther = scriptValues.find((s) => /--test\b/.test(s) || /node:test/.test(s));
    return {
      kind: "node:test",
      command: has(testScript, /--test\b/) || has(testScript, /node:test/)
        ? testScript
        : (fromOther ?? "node --test"),
    };
  }

  if (deps.vitest) return { kind: "vitest", command: "npx vitest run" };
  if (deps.jest) return { kind: "jest", command: null, jestSnippet: JEST_SNIPPET };

  return { kind: "none", command: null };
}

export function traceEnv(packages: string[], outPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SLIM_TRACE_PACKAGES: packages.join(","),
    SLIM_TRACE_OUT: outPath,
  };
}

export function nodeTestPreloadArgs(hookModuleAbsPath: string): string[] {
  return ["--import", pathToFileURL(hookModuleAbsPath).href];
}

const VITEST_CONFIG_NAMES = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cts",
  "vitest.config.cjs",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
];

export function findVitestUserConfig(root: string): string | null {
  for (const name of VITEST_CONFIG_NAMES) {
    const p = join(root, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function userConfigHasSlimPlugin(configPath: string): boolean {
  try {
    const text = readFileSync(configPath, "utf8");
    return /\bslimVitest\b/.test(text) || /["']slim\/vitest["']/.test(text);
  } catch {
    return false;
  }
}

function slimVitestSpecifier(): string {
  const jsPath = fileURLToPath(new URL("./vitest.js", import.meta.url));
  const tsPath = fileURLToPath(new URL("./vitest.ts", import.meta.url));
  if (existsSync(jsPath)) return pathToFileURL(jsPath).href;
  if (existsSync(tsPath)) return pathToFileURL(tsPath).href;
  return "slim/vitest";
}

export function writeVitestTraceConfig(root: string, packages: string[]): string {
  const dir = join(root, ".slim");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "vitest.trace.ts");
  const userAbs = findVitestUserConfig(root);
  let userConfigSpecifier: string | null = null;
  let alreadyHasPlugin = false;
  if (userAbs) {
    let rel = relative(dir, userAbs).replace(/\\/g, "/");
    if (!rel.startsWith(".")) rel = "./" + rel;
    userConfigSpecifier = rel;
    alreadyHasPlugin = userConfigHasSlimPlugin(userAbs);
  }
  writeFileSync(
    path,
    vitestTraceConfigSource(packages, slimVitestSpecifier(), {
      userConfigSpecifier,
      alreadyHasPlugin,
    }),
  );
  return path;
}

export function buildTraceSpawn(
  runner: DetectedRunner,
  opts: { hookPath: string; vitestConfigPath?: string },
): { file: string; args: string[] } | null {
  if (runner.kind === "jest" || runner.kind === "none" || !runner.command) return null;
  const parts = runner.command.split(/\s+/).filter(Boolean);
  const file = parts[0]!;
  if (runner.kind === "node:test") {
    return { file, args: [...nodeTestPreloadArgs(opts.hookPath), ...parts.slice(1)] };
  }
  if (runner.kind === "vitest") {
    const extra = opts.vitestConfigPath ? ["--config", opts.vitestConfigPath] : [];
    return { file, args: [...parts.slice(1), ...extra] };
  }
  return { file, args: parts.slice(1) };
}
