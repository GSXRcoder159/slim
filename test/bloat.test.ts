import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBloatCheck } from "../src/bloat.ts";
import { EXIT_FAIL, EXIT_OK } from "../src/exit.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function mini(pkg: Record<string, unknown>, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "slim-bloat-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "app", type: "module", ...pkg }),
  );
  for (const [p, body] of Object.entries(files)) {
    const abs = join(root, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

test("bloat OK when lodash is only imported in tests, not in dependencies", () => {
  const root = mini(
    { dependencies: {} },
    { "test/app.test.ts": `import get from "lodash/get.js";\n` },
  );
  assert.equal(runBloatCheck(root), EXIT_OK);
});

test("bloat OK when lodash is only a devDependency oracle", () => {
  const root = mini(
    { dependencies: {}, devDependencies: { lodash: "^4.17.21" } },
    { "test/oracle.test.ts": `import _ from "lodash";\n` },
  );
  assert.equal(runBloatCheck(root), EXIT_OK);
});

test("bloat FAIL when lodash is a production direct dependency without replacement", () => {
  const root = mini({ dependencies: { lodash: "^4.17.21" } });
  assert.equal(runBloatCheck(root), EXIT_FAIL);
});

test("bloat FAIL when moment is a production direct dependency without replacement", () => {
  const root = mini({ dependencies: { moment: "^2.30.1" } });
  assert.equal(runBloatCheck(root), EXIT_FAIL);
});

test("bloat OK when production lodash has a slim.json replacement", () => {
  const root = mini({ dependencies: { lodash: "^4.17.21" } });
  writeFileSync(
    join(root, "slim.json"),
    JSON.stringify({
      replacements: {
        lodash: {
          version: "4.17.21",
          envelope: ".slim/lodash/envelope.json",
          module: "src/slim/lodash.ts",
        },
      },
    }),
  );
  assert.equal(runBloatCheck(root), EXIT_OK);
});

test("bloat OK for Slim's own repo (lodash only in devDependencies)", () => {
  assert.equal(runBloatCheck(REPO_ROOT), EXIT_OK);
});
