/**
 * MIT License
 *
 * JSON Schema 2020-12 subset used by Slim packed schemas. No AJV.
 */

export type SchemaIssueKind =
  | "missing-field"
  | "malformed"
  | "stale-version"
  | "incompatible-version";

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

interface Ctx {
  root: JsonSchema;
  dir: string;
  loadFile?: (absPath: string) => JsonSchema;
  cache: Map<string, JsonSchema>;
}

export function validateSchema(
  schema: JsonSchema,
  value: unknown,
  opts: ValidateOptions = {},
): SchemaIssue | null {
  const dir = opts.schemaDir ?? "";
  return check(schema, value, "", {
    root: schema,
    dir,
    loadFile: opts.loadFile,
    cache: new Map(),
  });
}

function check(schema: JsonSchema, value: unknown, path: string, ctx: Ctx): SchemaIssue | null {
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, ctx);
    return check(resolved.schema, value, path, { ...ctx, root: resolved.root, dir: resolved.dir });
  }

  const versionIssue = classifySchemaVersion(schema, value, path);
  if (versionIssue) return versionIssue;

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    return issue("malformed", path, `expected type ${formatType(schema.type)}`);
  }
  if (schema.const !== undefined && !same(value, schema.const)) {
    return issue("malformed", path, `expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((item) => same(value, item))) {
    return issue("malformed", path, `expected one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return issue("malformed", path, `minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return issue("malformed", path, `maxLength ${schema.maxLength}`);
    }
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    return issue("malformed", path, `minimum ${schema.minimum}`);
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const child = check(schema.items, value[i], joinPath(path, String(i)), ctx);
      if (child) return child;
    }
  }
  if (!isObject(value)) return null;

  for (const key of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return issue("missing-field", joinPath(path, key), "required");
    }
  }

  const props = schema.properties ?? {};
  const extra = Object.keys(value).filter((k) => !(k in props));
  const addl = schema.additionalProperties;
  if (addl === false && extra.length) {
    return issue("malformed", joinPath(path, extra[0]!), "additional property");
  }
  if (addl && addl !== true) {
    for (const key of extra) {
      const child = check(addl, value[key], joinPath(path, key), ctx);
      if (child) return child;
    }
  }
  for (const [key, sub] of Object.entries(props)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const child = check(sub, value[key], joinPath(path, key), ctx);
    if (child) return child;
  }
  return null;
}

function classifySchemaVersion(schema: JsonSchema, value: unknown, path: string): SchemaIssue | null {
  const spec = schema.properties?.schemaVersion;
  if (!spec || (spec.const === undefined && spec.type === undefined)) return null;
  if (path !== "") return null;
  if (!isObject(value)) return null;
  const expected = typeof spec.const === "number" ? spec.const : undefined;
  if (expected === undefined) return null;
  const required = (schema.required ?? []).includes("schemaVersion");
  if (!Object.prototype.hasOwnProperty.call(value, "schemaVersion")) {
    return required ? issue("missing-field", "/schemaVersion", "required") : null;
  }
  const actual = value.schemaVersion;
  if (typeof actual !== "number" || !Number.isInteger(actual)) {
    return issue("incompatible-version", "/schemaVersion", `got ${JSON.stringify(actual)}`);
  }
  if (actual < expected) {
    return issue("stale-version", "/schemaVersion", `${actual} (expected ${expected})`);
  }
  if (actual !== expected) {
    return issue("incompatible-version", "/schemaVersion", `${actual} (expected ${expected})`);
  }
  return null;
}

function resolveRef(
  ref: string,
  ctx: Ctx,
): { schema: JsonSchema; root: JsonSchema; dir: string } {
  const hash = ref.indexOf("#");
  const file = hash === -1 ? ref : ref.slice(0, hash);
  const pointer = hash === -1 ? "" : ref.slice(hash + 1);
  let root = ctx.root;
  let dir = ctx.dir;
  if (file && file !== "#") {
    if (!ctx.loadFile) throw new Error(`$ref file ${file} needs loadFile`);
    const abs = joinFs(dir, file);
    const cached = ctx.cache.get(abs);
    root = cached ?? ctx.loadFile(abs);
    if (!cached) ctx.cache.set(abs, root);
    dir = dirnameFs(abs);
  }
  const schema = pointer ? lookupPointer(root, pointer) : root;
  return { schema, root, dir };
}

function lookupPointer(root: JsonSchema, pointer: string): JsonSchema {
  const parts = pointer.split("/").filter(Boolean);
  let cur: unknown = root;
  for (const part of parts) {
    if (!isObject(cur) || !(part in cur)) {
      throw new Error(`unresolved $ref #/${parts.join("/")}`);
    }
    cur = cur[part];
  }
  return cur as JsonSchema;
}

function matchesType(value: unknown, type: string | string[]): boolean {
  if (Array.isArray(type)) return type.some((t) => matchesType(value, t));
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number";
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  return false;
}

function formatType(type: string | string[]): string {
  return Array.isArray(type) ? type.join("|") : type;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function joinPath(base: string, key: string): string {
  return `${base}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function issue(kind: SchemaIssueKind, path: string, message: string): SchemaIssue {
  return { kind, path: path || "/", message };
}

function joinFs(dir: string, file: string): string {
  if (!dir) return file;
  const a = dir.replaceAll("\\", "/").replace(/\/$/, "");
  if (file.startsWith("/")) return file;
  const parts = `${a}/${file}`.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "." || p === "") {
      if (p === "" && out.length === 0) out.push("");
      continue;
    }
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/") || "/";
}

function dirnameFs(p: string): string {
  const n = p.replaceAll("\\", "/");
  const i = n.lastIndexOf("/");
  if (i <= 0) return "/";
  return n.slice(0, i);
}
