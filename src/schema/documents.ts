/**
 * MIT License
 *
 * Load packed JSON schemas and fail closed with classified SlimExit.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_FAIL, SlimExit } from "../exit.ts";
import { validateSchema, type JsonSchema, type SchemaIssue } from "./validate.ts";

const SCHEMA_FILES = {
  slim: "slim.schema.json",
  scan: "scan.schema.json",
  inspect: "inspect.schema.json",
  check: "check.schema.json",
  doctor: "doctor.schema.json",
  upstream: "upstream.schema.json",
  error: "error.schema.json",
  envelope: "envelope.schema.json",
  evidence: "evidence.schema.json",
  manifest: "manifest.schema.json",
  inventory: "support-inventory.schema.json",
  receipt: "receipt.schema.json",
  artifactIdentity: "artifact-identity.schema.json",
} as const;

export type SchemaName = keyof typeof SCHEMA_FILES;

export function docsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../docs");
}

const cache = new Map<string, JsonSchema>();

export function loadSchema(name: SchemaName): JsonSchema {
  const file = join(docsDir(), SCHEMA_FILES[name]);
  return loadSchemaFile(file);
}

export function loadSchemaFile(absPath: string): JsonSchema {
  const cached = cache.get(absPath);
  if (cached) return cached;
  if (!existsSync(absPath)) {
    throw new SlimExit(EXIT_FAIL, `missing schema ${absPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absPath, "utf8"));
  } catch {
    throw new SlimExit(EXIT_FAIL, `malformed schema ${absPath}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new SlimExit(EXIT_FAIL, `malformed schema ${absPath}`);
  }
  const schema = parsed as JsonSchema;
  cache.set(absPath, schema);
  return schema;
}

export function validateNamed(name: SchemaName, value: unknown): SchemaIssue | null {
  const file = join(docsDir(), SCHEMA_FILES[name]);
  return validateSchema(loadSchema(name), value, {
    schemaDir: dirname(file),
    loadFile: loadSchemaFile,
  });
}

export function formatSchemaIssue(name: string, issue: SchemaIssue): string {
  return `schema ${name}: ${issue.kind}: ${issue.path}: ${issue.message}`;
}

export function assertDocument(name: SchemaName, value: unknown, label: string = name): void {
  const issue = validateNamed(name, value);
  if (!issue) return;
  throw new SlimExit(EXIT_FAIL, formatSchemaIssue(label, issue));
}

export function readJsonFile(path: string, label = path): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new SlimExit(EXIT_FAIL, `malformed ${label}`);
  }
}

export function readDocument(name: SchemaName, path: string, label: string = path): unknown {
  const raw = readJsonFile(path, label);
  assertDocument(name, raw, label);
  return raw;
}
