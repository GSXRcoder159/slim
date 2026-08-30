import { EXIT_ENV, EXIT_OK, EXIT_REFUSED, EXIT_USAGE } from "./exit.js";
import { assertDocument } from "./schema/documents.js";
export const JSON_SCHEMA_VERSION = 1;
export function statusFromExit(code) {
    if (code === EXIT_OK)
        return "ok";
    if (code === EXIT_USAGE)
        return "usage";
    if (code === EXIT_REFUSED)
        return "refused";
    if (code === EXIT_ENV)
        return "env";
    return "fail";
}
export function writeJson(value) {
    process.stdout.write(JSON.stringify(value) + "\n");
}
export function writeErrorJson(exit, error) {
    const doc = errorDocument(exit, error);
    assertDocument("error", doc);
    writeJson(doc);
}
export function errorDocument(exit, error) {
    return {
        schemaVersion: JSON_SCHEMA_VERSION,
        ok: false,
        exit,
        status: statusFromExit(exit),
        error,
    };
}
//# sourceMappingURL=json.js.map