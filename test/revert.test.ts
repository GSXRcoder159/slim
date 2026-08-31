import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyRevert, formatRevert, type RevertPlan } from "../src/rewrite/revert.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const plan: RevertPlan = {
  package: "ms",
  version: "2.1.3",
  module: "src/slim/ms.ts",
  tests: "src/slim/ms.test.ts",
  cjsCompanion: "src/slim/ms.cjs",
  rewrites: [{ file: "src/index.ts", original: "ms", replacement: "./slim/ms.ts" }],
  lockfile: "npm",
  installCommand: "npm install",
};

test("formatRevert lists restore, delete, specifier, and install steps", () => {
  const text = formatRevert(plan);
  assert.match(text, /Restore `ms@2\.1\.3`/);
  assert.match(text, /src\/slim\/ms\.ts/);
  assert.match(text, /src\/index\.ts/);
  assert.match(text, /npm install/);
  assert.match(text, /git revert/);
});

test("applyRevert restores the dep, deletes slice files, and splices specifiers", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-revert-"));
  mkdirSync(join(root, "src", "slim"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "t", dependencies: {}, devDependencies: { typescript: "5.9.2" } }, null, 2) + "\n",
  );
  writeFileSync(join(root, "src", "index.ts"), `import ms from "./slim/ms.ts";\nexport const n = ms("1h");\n`);
  writeFileSync(join(root, "src", "slim", "ms.ts"), "export default function ms() {}\n");
  writeFileSync(join(root, "src", "slim", "ms.test.ts"), "import { test } from 'node:test';\n");
  writeFileSync(join(root, "src", "slim", "ms.cjs"), "module.exports = {};\n");
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(join(ROOT, "node_modules", "typescript"), join(root, "node_modules", "typescript"));
  applyRevert(root, plan);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  assert.equal(pkg.dependencies.ms, "2.1.3");
  assert.equal(existsSync(join(root, "src", "slim", "ms.ts")), false);
  assert.equal(existsSync(join(root, "src", "slim", "ms.test.ts")), false);
  assert.equal(existsSync(join(root, "src", "slim", "ms.cjs")), false);
  assert.match(readFileSync(join(root, "src", "index.ts"), "utf8"), /from "ms"/);
});

test("applyRevert rolls back every mutation when a later rewrite is unsupported", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-revert-atomic-"));
  mkdirSync(join(root, "src", "slim"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: {} }) + "\n");
  writeFileSync(join(root, "src", "index.ts"), `import ms from "./slim/ms.ts";\n`);
  writeFileSync(join(root, "src", "slim", "ms.ts"), "slice\n");
  const before = readFileSync(join(root, "package.json"), "utf8");
  assert.throws(() => applyRevert(root, { ...plan, rewrites: [{ ...plan.rewrites[0]!, replacement: "./missing.ts" }] }));
  assert.equal(readFileSync(join(root, "package.json"), "utf8"), before);
  assert.equal(readFileSync(join(root, "src", "index.ts"), "utf8"), `import ms from "./slim/ms.ts";\n`);
  assert.equal(existsSync(join(root, "src", "slim", "ms.ts")), true);
});
