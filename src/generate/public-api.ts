import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OriginalSourceGuard } from "./guard.ts";

export function loadPublicApi(projectRoot: string, pkg: string): string {
  const dts = [
    join(projectRoot, "node_modules", pkg, "index.d.ts"),
    join(projectRoot, "node_modules", "@types", pkg, "index.d.ts"),
    join(projectRoot, "node_modules", pkg, `${pkg}.d.ts`),
  ];
  for (const p of dts) {
    if (existsSync(p)) {
      OriginalSourceGuard.assertNotOriginalImpl(p);
      return OriginalSourceGuard.readPublicSpec(p);
    }
  }
  const readme = join(projectRoot, "node_modules", pkg, "README.md");
  if (existsSync(readme)) {
    return OriginalSourceGuard.readPublicSpec(readme).slice(0, 8000);
  }
  return `package ${pkg} — no local .d.ts; implement from envelope call sites only.`;
}

export { readFileSync };
