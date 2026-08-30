/**
 * MIT License
 *
 * Load packed JSON schemas and fail closed with classified SlimExit.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_FAIL, SlimExit } from "../exit.js";
import { validateSchema } from "./validate.js";
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
};
export function docsDir() {
    return join(dirname(fileURLToPath(import.meta.url)), "../../docs");
}
const cache = new Map();
export function loadSchema(name) {
    const file = join(docsDir(), SCHEMA_FILES[name]);
    return loadSchemaFile(file);
}
export function loadSchemaFile(absPath) {
    const cached = cache.get(absPath);
    if (cached)
        return cached;
    if (!existsSync(absPath)) {
        throw new SlimExit(EXIT_FAIL, `missing schema ${absPath}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(absPath, "utf8"));
    }
    catch {
        throw new SlimExit(EXIT_FAIL, `malformed schema ${absPath}`);
    }
    if (!parsed || typeof parsed !== "object") {
        throw new SlimExit(EXIT_FAIL, `malformed schema ${absPath}`);
    }
    const schema = parsed;
    cache.set(absPath, schema);
    return schema;
}
export function validateNamed(name, value) {
    const file = join(docsDir(), SCHEMA_FILES[name]);
    return validateSchema(loadSchema(name), value, {
        schemaDir: dirname(file),
        loadFile: loadSchemaFile,
    });
}
export function formatSchemaIssue(name, issue) {
    return `schema ${name}: ${issue.kind}: ${issue.path}: ${issue.message}`;
}
export function assertDocument(name, value, label = name) {
    const issue = validateNamed(name, value);
    if (!issue)
        return;
    throw new SlimExit(EXIT_FAIL, formatSchemaIssue(label, issue));
}
export function readJsonFile(path, label = path) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        throw new SlimExit(EXIT_FAIL, `malformed ${label}`);
    }
}
export function readDocument(name, path, label = path) {
    const raw = readJsonFile(path, label);
    assertDocument(name, raw, label);
    return raw;
}
//# sourceMappingURL=documents.js.map