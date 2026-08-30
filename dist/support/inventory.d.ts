/**
 * MIT License
 *
 * Load and query the checked-in support inventory.
 */
export type ReceiptClass = "local" | "live";
export type InventoryKind = "command" | "jsonCommand" | "package" | "alias" | "symbol" | "runtime" | "osNode" | "packageManager" | "provider" | "externalService" | "action";
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
export declare const INVENTORY_OS: readonly ["ubuntu-latest", "macos-latest", "windows-latest"];
export declare const INVENTORY_NODES: readonly ["22.18", "24"];
export declare function canonicalInventory(): SupportInventory;
export declare function inventoryPath(): string;
export declare function loadInventory(): SupportInventory;
export declare function inventoryById(inv?: SupportInventory): Map<string, InventoryEntry>;
export declare function jsonCommands(inv?: SupportInventory): string[];
export declare function repoRootFromSupport(): string;
