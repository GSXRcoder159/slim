import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePackageFamily } from "../src/analyze/family.ts";
import {
  allCatalogEntries,
  CATALOG_PKG_ALIAS,
  LODASH_SYMBOLS,
} from "../src/generate/catalog/index.ts";
import { canonicalInventory, loadInventory } from "../src/support/inventory.ts";
import { helpText } from "../src/cli.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("checked-in inventory matches canonicalInventory and schema", () => {
  const loaded = loadInventory();
  assert.deepEqual(loaded, canonicalInventory());
  const ids = loaded.entries.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate inventory ids");
});

test("every inventory entry has docs and an existing checkId", () => {
  const loaded = loadInventory();
  for (const entry of loaded.entries) {
    assert.ok(entry.docs.length, `${entry.id} missing docs`);
    for (const doc of entry.docs) {
      assert.ok(existsSync(join(ROOT, doc)), `${entry.id} docs missing ${doc}`);
    }
    assert.ok(existsSync(join(ROOT, entry.checkId)), `${entry.id} checkId missing ${entry.checkId}`);
  }
});

test("catalog symbols, aliases, CI matrix, and actions match inventory", () => {
  const byId = new Map(loadInventory().entries.map((e) => [e.id, e]));
  for (const entry of allCatalogEntries()) {
    assert.ok(byId.has(`symbol.${entry.id}`), `missing symbol.${entry.id}`);
  }
  for (const alias of Object.keys(CATALOG_PKG_ALIAS)) {
    assert.ok(byId.has(`alias.${alias}`), `missing alias.${alias}`);
  }
  for (const symbol of LODASH_SYMBOLS) {
    assert.ok(byId.has(`alias.lodash.${symbol}`), `missing alias.lodash.${symbol}`);
  }
  for (const os of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
    for (const node of ["22.18", "24"]) {
      assert.ok(byId.has(`osNode.${os}.${node}`), `missing osNode.${os}.${node}`);
    }
  }
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /ubuntu-latest/);
  assert.match(ci, /macos-latest/);
  assert.match(ci, /windows-latest/);
  assert.match(ci, /"22\.18"/);
  assert.match(ci, /"24"/);
  for (const name of ["check", "bloat", "upstream"]) {
    assert.ok(byId.has(`action.${name}`), `missing action.${name}`);
    assert.ok(existsSync(join(ROOT, `action/${name}/action.yml`)));
  }
});

test("qs and query-string are not advertised catalog aliases", () => {
  const loaded = loadInventory();
  assert.equal(resolvePackageFamily("qs")?.family, "qs");
  assert.equal(resolvePackageFamily("query-string")?.family, "qs");
  assert.equal(loaded.entries.some((e) => e.kind === "alias" && (e.name === "qs" || e.name === "query-string")), false);
  assert.equal(loaded.entries.some((e) => e.kind === "package" && e.name === "qs"), false);
});

test("help, README, dx, and packages only advertise inventory names", () => {
  const loaded = loadInventory();
  const commands = new Set(
    loaded.entries.filter((e) => e.kind === "command").map((e) => e.command),
  );
  const json = new Set(
    loaded.entries.filter((e) => e.kind === "jsonCommand").map((e) => e.command),
  );
  const symbols = new Set(loaded.entries.filter((e) => e.kind === "symbol").map((e) => e.name));
  const help = helpText();
  for (const name of ["scan", "inspect", "replace", "check", "bloat", "upstream", "watch", "doctor"]) {
    assert.ok(commands.has(name), `help command ${name} missing from inventory`);
    assert.match(help, new RegExp(`slim ${name === "watch" ? "watch" : name}`));
  }
  assert.equal(json.has("replace"), false);
  assert.match(help, /replace does not support --json/);
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const dx = readFileSync(join(ROOT, "docs/dx.md"), "utf8");
  const packages = readFileSync(join(ROOT, "docs/packages.md"), "utf8");
  assert.doesNotMatch(readme, /Global flags/);
  assert.doesNotMatch(dx, /### Global flags \(every command\)/);
  assert.match(dx, /`--json` is \*\*not\*\* global/);
  assert.match(readme, /support-inventory\.json/);
  assert.match(dx, /support-inventory\.json/);
  assert.match(packages, /scan-family grouping only, not catalog/);
  assert.doesNotMatch(packages, /\*\*qs\*\*/);
  for (const id of [...symbols]) {
    const symbol = id!.split(".").slice(1).join(".");
    assert.match(packages, new RegExp(`\`${symbol}\``), `packages.md missing ${id}`);
  }
  assert.equal(json.size, 5);
});

test("inventory replace.json is false", () => {
  const replace = loadInventory().entries.find((e) => e.id === "command.replace");
  assert.equal(replace?.json, false);
});
