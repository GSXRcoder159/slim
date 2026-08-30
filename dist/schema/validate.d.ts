/**
 * MIT License
 *
 * JSON Schema 2020-12 subset used by Slim packed schemas. No AJV.
 */
export type SchemaIssueKind = "missing-field" | "malformed" | "stale-version" | "incompatible-version";
export interface SchemaIssue {
    kind: SchemaIssueKind;
    path: string;
    message: string;
}
export type JsonSchema = {
    type?: string | string[];
    const?: unknown;
    enum?: unknown[];
    required?: string[];
    additionalProperties?: boolean | JsonSchema;
    properties?: Record<string, JsonSchema>;
    items?: JsonSchema;
    $ref?: string;
    $defs?: Record<string, JsonSchema>;
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    [key: string]: unknown;
};
export interface ValidateOptions {
    schemaDir?: string;
    loadFile?: (absPath: string) => JsonSchema;
}
export declare function validateSchema(schema: JsonSchema, value: unknown, opts?: ValidateOptions): SchemaIssue | null;
