/**
 * MIT License
 *
 * Load and query the checked-in support inventory.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_NODE_ENGINES } from "../node-min.ts";
import {
  allCatalogEntries,
  CATALOG_PKG_ALIAS,
  LODASH_SYMBOLS,
} from "../generate/catalog/index.ts";
import { assertDocument, docsDir } from "../schema/documents.ts";

export type ReceiptClass = "local" | "live";

export type InventoryKind =
  | "command"
  | "jsonCommand"
  | "package"
  | "alias"
  | "symbol"
  | "runtime"
  | "osNode"
  | "packageManager"
  | "provider"
  | "externalService"
  | "action";

export interface InventoryEntry {
  id: string;
  kind: InventoryKind;
  docs: string[];
  checkId: string;
  receiptClass: ReceiptClass;
  command?: string;
  json?: boolean;
  aliasOf?: string;
  name?: string;
  os?: string;
  node?: string;
}

export interface SupportInventory {
  schemaVersion: 1;
  entries: InventoryEntry[];
}

const COMMANDS = ["scan", "inspect", "replace", "check", "bloat", "upstream", "doctor"] as const;
const JSON_COMMANDS = ["scan", "inspect", "check", "upstream", "doctor"] as const;
export const INVENTORY_OS = ["ubuntu-latest", "macos-latest", "windows-latest"] as const;
export const INVENTORY_NODES = ["22.18", "24"] as const;
const OS = INVENTORY_OS;
const NODES = INVENTORY_NODES;
const PMS = ["npm", "pnpm", "yarn", "bun"] as const;
const PACKAGES = [
  "lodash",
  "moment",
  "uuid",
  "ms",
  "nanoid",
  "clsx",
  "whatwg-url",
  "bluebird",
  "mime-types",
] as const;

function e(
  partial: InventoryEntry,
): InventoryEntry {
  return partial;
}

export function canonicalInventory(): SupportInventory {
  const entries: InventoryEntry[] = [];
  for (const command of COMMANDS) {
    entries.push(
      e({
        id: `command.${command}`,
        kind: "command",
        command,
        json: (JSON_COMMANDS as readonly string[]).includes(command),
        docs: ["docs/help.txt", "docs/dx.md", "README.md", "docs/help-commands.txt"],
        checkId: "test/cli.test.ts",
        receiptClass: "local",
      }),
    );
  }
  entries.push(
    e({
      id: "command.watch",
      kind: "command",
      command: "watch",
      aliasOf: "upstream",
      json: true,
      docs: ["docs/help.txt", "docs/dx.md", "README.md", "docs/help-commands.txt"],
      checkId: "test/cli.test.ts",
      receiptClass: "local",
    }),
  );
  for (const command of JSON_COMMANDS) {
    entries.push(
      e({
        id: `jsonCommand.${command}`,
        kind: "jsonCommand",
        command,
        json: true,
        docs: [`docs/${command}.schema.json`, "docs/dx.md", "docs/help-commands.txt"],
        checkId: "test/json-contract.test.ts",
        receiptClass: "local",
      }),
    );
  }
  for (const name of PACKAGES) {
    entries.push(
      e({
        id: `package.${name}`,
        kind: "package",
        name,
        docs: ["docs/packages.md"],
        checkId: "test/catalog/index.test.ts",
        receiptClass: "local",
      }),
    );
  }
  for (const [alias, canon] of Object.entries(CATALOG_PKG_ALIAS)) {
    entries.push(
      e({
        id: `alias.${alias}`,
        kind: "alias",
        name: alias,
        aliasOf: canon,
        docs: ["docs/packages.md"],
        checkId: "test/catalog/packed-e2e.test.ts",
        receiptClass: "local",
      }),
    );
  }
  for (const symbol of LODASH_SYMBOLS) {
    const alias = `lodash.${symbol}`;
    entries.push(
      e({
        id: `alias.${alias}`,
        kind: "alias",
        name: alias,
        aliasOf: "lodash",
        docs: ["docs/packages.md"],
        checkId: "test/catalog/index.test.ts",
        receiptClass: "local",
      }),
    );
  }
  for (const entry of allCatalogEntries()) {
    entries.push(
      e({
        id: `symbol.${entry.id}`,
        kind: "symbol",
        name: entry.id,
        docs: ["docs/packages.md"],
        checkId: "test/catalog/qualify-matrix.test.ts",
        receiptClass: "local",
      }),
    );
  }
  entries.push(
    e({
      id: "runtime.node",
      kind: "runtime",
      name: MIN_NODE_ENGINES,
      docs: ["README.md", "docs/dx.md"],
      checkId: "test/docs-contract.test.ts",
      receiptClass: "local",
    }),
  );
  for (const os of OS) {
    for (const node of NODES) {
      entries.push(
        e({
          id: `osNode.${os}.${node}`,
          kind: "osNode",
          os,
          node,
          docs: ["README.md", ".github/workflows/ci.yml"],
          checkId: "test/docs-contract.test.ts",
          receiptClass: "local",
        }),
      );
    }
  }
  for (const name of PMS) {
    entries.push(
      e({
        id: `packageManager.${name}`,
        kind: "packageManager",
        name,
        docs: ["docs/dx.md"],
        checkId: "test/replace-lockfile-pm.test.ts",
        receiptClass: "local",
      }),
    );
  }
  for (const name of ["anthropic", "openai"] as const) {
    entries.push(
      e({
        id: `provider.${name}`,
        kind: "provider",
        name,
        docs: ["README.md", "docs/dx.md"],
        checkId: "test/llm-live.test.ts",
        receiptClass: "live",
      }),
    );
  }
  entries.push(
    e({
      id: "externalService.osv",
      kind: "externalService",
      name: "osv",
      docs: ["docs/dx.md"],
      checkId: "test/upstream-live.test.ts",
      receiptClass: "live",
    }),
    e({
      id: "externalService.npm-registry",
      kind: "externalService",
      name: "npm-registry",
      docs: ["docs/dx.md"],
      checkId: "test/upstream-live.test.ts",
      receiptClass: "live",
    }),
    e({
      id: "externalService.github",
      kind: "externalService",
      name: "github",
      docs: ["docs/dx.md", "README.md"],
      checkId: "test/github/pr-live.test.ts",
      receiptClass: "live",
    }),
    e({
      id: "externalService.npm-publish",
      kind: "externalService",
      name: "npm-publish",
      docs: ["docs/repo.md", ".github/workflows/release.yml"],
      checkId: "test/release-live.test.ts",
      receiptClass: "live",
    }),
  );
  for (const name of ["check", "bloat", "upstream"] as const) {
    entries.push(
      e({
        id: `action.${name}`,
        kind: "action",
        name,
        docs: [`action/${name}/action.yml`, "docs/dx.md", `docs/examples/slim-${name === "upstream" ? "watch" : name}.yml`],
        checkId: "test/github/action-live.test.ts",
        receiptClass: "live",
      }),
    );
  }
  return { schemaVersion: 1, entries };
}

export function inventoryPath(): string {
  return join(docsDir(), "support-inventory.json");
}

export function loadInventory(): SupportInventory {
  const raw = JSON.parse(readFileSync(inventoryPath(), "utf8")) as unknown;
  assertDocument("inventory", raw);
  return raw as SupportInventory;
}

export function inventoryById(inv = loadInventory()): Map<string, InventoryEntry> {
  return new Map(inv.entries.map((entry) => [entry.id, entry]));
}

export function jsonCommands(inv = loadInventory()): string[] {
  return inv.entries.filter((e) => e.kind === "jsonCommand").map((e) => e.command!).sort();
}

export function repoRootFromSupport(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../..");
}
