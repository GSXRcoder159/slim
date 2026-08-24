import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { TraceEvent } from "../envelope/types.ts";
import { siblingModule } from "../runtime-path.ts";
import { wrapExports } from "./proxy.ts";
import { matchesTracedUrl, packageFromUrl } from "./hook.ts";

export { wrapExports };

function vitestModuleHref(): string {
  return pathToFileURL(siblingModule(import.meta.url, "vitest")).href;
}

/** Source for `.slim/vitest.trace.ts` used only for the TRACE run. */
export type VitestTraceConfigOpts = {
  userConfigSpecifier?: string | null;
  alreadyHasPlugin?: boolean;
};

export function vitestTraceConfigSource(
  packages: string[],
  pluginSpecifier: string,
  opts?: VitestTraceConfigOpts,
): string {
  const user = opts?.userConfigSpecifier;
  if (user && opts?.alreadyHasPlugin) {
    return `export { default } from ${JSON.stringify(user)};\n`;
  }
  const pluginConfig = `{
  plugins: [slimVitest({ packages: ${JSON.stringify(packages)} })],
}`;
  if (user) {
    return `import { defineConfig, mergeConfig } from "vitest/config";
import { slimVitest } from ${JSON.stringify(pluginSpecifier)};
import userConfig from ${JSON.stringify(user)};

export default defineConfig(async (env) => {
  const resolved = typeof userConfig === "function" ? await userConfig(env) : userConfig;
  return mergeConfig(resolved, ${pluginConfig});
});
`;
  }
  return `import { slimVitest } from ${JSON.stringify(pluginSpecifier)};

export default ${pluginConfig};
`;
}

export type SlimVitestPlugin = {
  name: "slim-vitest";
  enforce?: "pre";
  config?: (...args: unknown[]) => unknown;
  transform?: (code: string, id: string) => unknown;
  resolveId?: (id: string, importer?: string) => unknown;
  load?: (id: string) => unknown;
};

function packagesFromEnv(): string[] {
  return (process.env.SLIM_TRACE_PACKAGES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function slimWrapperSource(id: string, packageName: string): string {
  const orig = JSON.stringify(id.includes("?") ? `${id}&slim-orig=1` : `${id}?slim-orig`);
  const spec = JSON.stringify(vitestModuleHref());
  return `import * as orig from ${orig};
import { wrapExports } from ${spec};
const wrapped = wrapExports(orig, {
  packageName: ${JSON.stringify(packageName)},
  onEvent: (e) => { globalThis.__slimTraceOnEvent && globalThis.__slimTraceOnEvent(e); },
});
export default wrapped.default !== undefined ? wrapped.default : wrapped;
export * from ${orig};
`;
}

export function slimVitest(opts?: { packages?: string[] }): SlimVitestPlugin {
  const packages = opts?.packages ?? packagesFromEnv();

  return {
    name: "slim-vitest",
    enforce: "pre",
    config() {
      return { optimizeDeps: { exclude: packages } };
    },
    resolveId(id: string) {
      if (id.includes("slim-orig")) return null;
      return null;
    },
    load(id: string) {
      if (id.includes("slim-orig")) return null;
      const hit =
        matchesTracedUrl(id, packages) ||
        packages.some((p) => id.includes(`/node_modules/${p}/`));
      if (!hit) return null;
      const pkg =
        packageFromUrl(id, packages) ??
        packages.find((p) => id.includes(`/node_modules/${p}`)) ??
        packages[0] ??
        "unknown";
      return slimWrapperSource(id, pkg);
    },
    transform(_code: string, _id: string) {
      return null;
    },
  };
}

export default slimVitest;

type SlimGlobal = typeof globalThis & {
  __slimTraceOnEvent?: (e: TraceEvent) => void;
};

function ensureVitestSink(): void {
  const g = globalThis as SlimGlobal;
  if (typeof g.__slimTraceOnEvent === "function") return;
  const outPath = process.env.SLIM_TRACE_OUT;
  if (!outPath) {
    g.__slimTraceOnEvent = () => {};
    return;
  }
  g.__slimTraceOnEvent = (e: TraceEvent) => {
    mkdirSync(dirname(outPath), { recursive: true });
    appendFileSync(outPath, JSON.stringify(e) + "\n");
  };
}

ensureVitestSink();
