#!/usr/bin/env node
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalogSrc = join(root, "src/generate/catalog");
const catalogDest = join(root, "dist/generate/catalog");
mkdirSync(catalogDest, { recursive: true });
for (const name of readdirSync(catalogSrc)) {
  if (name.endsWith(".ts")) {
    copyFileSync(join(catalogSrc, name), join(catalogDest, name));
  }
}
copyFileSync(join(root, "docs/slim.schema.json"), join(root, "slim.schema.json"));
