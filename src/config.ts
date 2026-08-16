import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SlimConfig {
  outDir: string;
  budgetMs: number;
  testCommand: string | null;
  include: string[];
  ignore: string[];
  replacements: Record<
    string,
    { version: string; envelope: string; module: string }
  >;
}

export const DEFAULT_CONFIG: SlimConfig = {
  outDir: "src/slim",
  budgetMs: process.env.CI ? 300_000 : 30_000,
  testCommand: null,
  include: [],
  ignore: [],
  replacements: {},
};

export function loadConfig(projectRoot: string): SlimConfig {
  const path = ["slim.json", "slim.config.json"]
    .map((f) => join(projectRoot, f))
    .find((p) => existsSync(p));
  if (!path) return { ...DEFAULT_CONFIG, replacements: {} };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SlimConfig>;
  return {
    outDir: raw.outDir ?? DEFAULT_CONFIG.outDir,
    budgetMs: raw.budgetMs ?? DEFAULT_CONFIG.budgetMs,
    testCommand: raw.testCommand ?? null,
    include: raw.include ?? [],
    ignore: raw.ignore ?? [],
    replacements: raw.replacements ?? {},
  };
}
