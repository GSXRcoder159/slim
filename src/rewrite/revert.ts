import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadTargetTypescript } from "../project.ts";
import { restoreDependencyKey } from "./packagejson.ts";
import { assertSafeWrite } from "./paths.ts";
import { rewriteSpecifiers } from "./splice.ts";
import { MutationTxn } from "./transaction.ts";

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
  const deletes = [plan.module, plan.tests, plan.cjsCompanion].filter(Boolean) as string[];
  const targets = ["package.json", ...deletes, ...plan.rewrites.map((rw) => rw.file)];
  const absTargets = [...new Set(targets.map((p) => resolve(root, p)))];
  for (const abs of absTargets) assertSafeWrite(root, abs);
  for (const rw of plan.rewrites) {
    if (!existsSync(resolve(root, rw.file))) throw new Error(`revert source is missing: ${rw.file}`);
  }

  const txn = new MutationTxn(root);
  try {
    for (const abs of absTargets) txn.snapshot(abs);
    txn.writeFile(pkgPath, restoreDependencyKey(readFileSync(pkgPath, "utf8"), plan.package, plan.version));
    for (const p of deletes) {
      const abs = resolve(root, p);
      if (existsSync(abs)) unlinkSync(abs);
    }
    const ts = loadTargetTypescript(root);
    for (const rw of plan.rewrites) {
      const abs = resolve(root, rw.file);
      const src = readFileSync(abs, "utf8");
      const out = rewriteSpecifiers(ts, src, abs, new Set([rw.replacement]), rw.original);
      if (!out.changed) throw new Error(`revert specifier is missing: ${rw.replacement} in ${rw.file}`);
      txn.writeFile(abs, out.text);
    }
    txn.commit();
  } catch (err) {
    txn.rollback();
    throw err;
  }
}
