import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTargetTypescript } from "../project.ts";
import { restoreDependencyKey } from "./packagejson.ts";
import { rewriteSpecifiers } from "./splice.ts";

export interface RevertRewrite {
  file: string;
  original: string;
  replacement: string;
}

export interface RevertPlan {
  package: string;
  version: string;
  module: string;
  tests: string;
  cjsCompanion: string | null;
  rewrites: RevertRewrite[];
  lockfile: "npm" | "pnpm" | "yarn" | "bun" | null;
  installCommand: string;
}

export function formatRevert(plan: RevertPlan): string {
  const deletes = [plan.module, plan.tests, plan.cjsCompanion].filter(Boolean) as string[];
  const files = [...new Set(plan.rewrites.map((r) => r.file))];
  const lines = [
    `1. Restore \`${plan.package}@${plan.version}\` in package.json.`,
    `2. Delete ${deletes.map((p) => "`" + p + "`").join(" and ")}.`,
  ];
  if (files.length) lines.push(`3. Restore import specifiers in: ${files.join(", ")}`);
  lines.push(`4. Run \`${plan.installCommand}\`.`);
  lines.push("Or: git revert the Slim PR.");
  return lines.join("\n");
}

export function applyRevert(root: string, plan: RevertPlan): void {
  const pkgPath = join(root, "package.json");
  const next = restoreDependencyKey(readFileSync(pkgPath, "utf8"), plan.package, plan.version);
  writeFileSync(pkgPath, next);
  for (const p of [plan.module, plan.tests, plan.cjsCompanion]) {
    if (!p) continue;
    const abs = join(root, p);
    try {
      if (existsSync(abs)) unlinkSync(abs);
    } catch {
      /* keep going */
    }
  }
  const ts = loadTargetTypescript(root);
  for (const rw of plan.rewrites) {
    const abs = join(root, rw.file);
    if (!existsSync(abs)) continue;
    const src = readFileSync(abs, "utf8");
    const out = rewriteSpecifiers(ts, src, abs, new Set([rw.replacement]), rw.original);
    if (out.changed) writeFileSync(abs, out.text);
  }
}
