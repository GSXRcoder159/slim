import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type RunnerKind = "node:test" | "vitest" | "jest" | "none";

export interface DetectedRunner {
  kind: RunnerKind;
  command: string | null;
  jestSnippet?: string;
}

const JEST_SNIPPET = `// Slim v1 does not wrap Jest.
// Use moduleNameMapper as a manual escape hatch:
//
//   moduleNameMapper: {
//     '^lodash$': '<rootDir>/node_modules/lodash/lodash.js',
//     '^lodash-es$': '<rootDir>/node_modules/lodash-es/index.js',
//   }
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
