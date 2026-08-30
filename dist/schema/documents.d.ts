/**
 * MIT License
 *
 * Load packed JSON schemas and fail closed with classified SlimExit.
 */
import { type JsonSchema, type SchemaIssue } from "./validate.ts";
declare const SCHEMA_FILES: {
    readonly slim: "slim.schema.json";
    readonly scan: "scan.schema.json";
    readonly inspect: "inspect.schema.json";
    readonly check: "check.schema.json";
    readonly doctor: "doctor.schema.json";
    readonly upstream: "upstream.schema.json";
    readonly error: "error.schema.json";
    readonly envelope: "envelope.schema.json";
    readonly evidence: "evidence.schema.json";
    readonly manifest: "manifest.schema.json";
    readonly inventory: "support-inventory.schema.json";
    readonly receipt: "receipt.schema.json";
    readonly artifactIdentity: "artifact-identity.schema.json";
};
export type SchemaName = keyof typeof SCHEMA_FILES;
export declare function docsDir(): string;
export declare function loadSchema(name: SchemaName): JsonSchema;
export declare function loadSchemaFile(absPath: string): JsonSchema;
export declare function validateNamed(name: SchemaName, value: unknown): SchemaIssue | null;
export declare function formatSchemaIssue(name: string, issue: SchemaIssue): string;
export declare function assertDocument(name: SchemaName, value: unknown, label?: string): void;
export declare function readJsonFile(path: string, label?: string): unknown;
export declare function readDocument(name: SchemaName, path: string, label?: string): unknown;
export {};
