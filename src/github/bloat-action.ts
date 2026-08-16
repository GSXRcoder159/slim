import { scanProject } from "../scan.ts";
import { BLOAT_PACKAGES } from "../scan/refuse.ts";
import { loadConfig } from "../config.ts";
import { loadProject } from "../project.ts";
import { EXIT_FAIL, EXIT_OK } from "../exit.ts";

const project = loadProject();
const config = loadConfig(project.root);
const report = scanProject();
const replaced = new Set(Object.keys(config.replacements));
const bad = report.rows.filter(
  (r) => BLOAT_PACKAGES.has(r.name) && r.importSites > 0 && !replaced.has(r.name) && !replaced.has(r.family),
);
if (bad.length) {
  process.stderr.write(
    "slim-bloat: fat/Edge-hostile package without a Slim replacement:\n" +
      bad.map((b) => `  ${b.name} (${b.importSites} import sites)`).join("\n") +
      "\n",
  );
  process.exit(EXIT_FAIL);
}
process.stdout.write("slim-bloat: ok\n");
process.exit(EXIT_OK);
