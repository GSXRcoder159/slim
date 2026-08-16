import { createHash } from "node:crypto";

export const ENVELOPE_VERSION = 1 as const;

export type Confidence = "closed" | "trace-closed" | "open";
export type EnvKind = "node" | "worker" | "browser" | "jsdom" | "unknown";
export type SlimmableVerdict = "slim" | "review" | "refuse";
export type ImportKind =
  | "named"
  | "default"
  | "namespace"
  | "cjs-require"
  | "subpath-default"
  | "side-effect";

export type ThisBinding =
  | { kind: "unbound" }
  | { kind: "method" }
  | { kind: "call" }
  | { kind: "apply" }
  | { kind: "bind" }
  | { kind: "unknown"; reason: string };

export type UnknownKind =
  | "dynamic-member"
  | "dynamic-specifier"
  | "spread-args"
  | "binding-escape"
  | "namespace-escape"
  | "eval"
  | "ts-any";

export interface PackageRef {
  name: string;
  version: string;
  family: string;
  subpath: string;
}

export interface SourceLoc {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface ImportSite {
  loc: SourceLoc;
  specifier: string;
  kind: ImportKind;
  names: string[];
}

export interface ArgShape {
  kind:
    | "literal"
    | "union"
    | "object"
    | "array"
    | "function"
    | "date"
    | "any"
    | "unknown";
  literals?: unknown[];
  props?: Record<string, ArgShape>;
  fnArity?: number;
}

export interface CallSite {
  id: string;
  loc: SourceLoc;
  exportName: string;
  memberPath: string[];
  thisBinding: ThisBinding;
  argc: { min: number; max: number | null; observed: number[] };
  argShapes: ArgShape[];
  spread: boolean;
  resultMembers: string[];
}

export interface HyrumFlags {
  errorMessage: boolean;
  toString: boolean;
  json: boolean;
  nan: boolean;
  sparseArray: boolean;
  keyOrder: boolean;
  prototype: boolean;
  mutation: boolean;
  dateIdentity: boolean;
  sameReference: boolean;
  /** When true, -0 and +0 are not equal. */
  signedZero?: boolean;
}

export interface SymbolEnvelope {
  exportName: string;
  packages: PackageRef[];
  callSites: CallSite[];
  resultMembers: string[];
  hyrum: HyrumFlags;
  coverage: {
    callSitesStatic: number;
    callSitesTraced: number;
  };
}

export interface UnknownSite {
  id: string;
  loc: SourceLoc;
  kind: UnknownKind;
  detail: string;
  widensTo: "all-exports" | "full-signature" | "refuse";
  traceObservedMembers: string[] | null;
}

export interface TraceEvent {
  symbol: string;
  args: SlimValue[];
  thisArg?: SlimValue;
  result?: SlimValue;
  threw?: { name: string; message: string; code?: string };
  mutatedArgIndexes?: number[];
  tRelMs?: number;
  sessionId?: string;
}

export type SlimValue =
  | { t: "undef" }
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "num"; v: number | "NaN" | "-0" | "Infinity" | "-Infinity" }
  | { t: "str"; v: string; redacted?: boolean }
  | { t: "bigint"; v: string }
  | { t: "date"; v: number }
  | { t: "err"; name: string; message: string; code?: string | number }
  | { t: "arr"; v: SlimValue[]; holes: number[] }
  | { t: "obj"; keys: string[]; v: Record<string, SlimValue> }
  | { t: "map"; v: [SlimValue, SlimValue][] }
  | { t: "set"; v: SlimValue[] }
  | { t: "fn"; name?: string; length?: number }
  | { t: "bytes"; kind?: string; len?: number; b64?: string }
  | { t: "ref"; id: number }
  | { t: "promise" }
  | { t: "regexp"; source: string; flags: string };

export interface Envelope {
  schemaVersion: typeof ENVELOPE_VERSION;
  package: PackageRef;
  env: EnvKind[];
  imports: ImportSite[];
  symbols: SymbolEnvelope[];
  unknowns: UnknownSite[];
  traces: TraceEvent[];
  closure: {
    confidence: Confidence;
    readyToGenerate: boolean;
    untracedCallSiteIds: string[];
    reason: string;
  };
  slimmable: {
    score: number;
    verdict: SlimmableVerdict;
    blockers: string[];
    reasons: string[];
  };
  clock: boolean;
  cryptoRandom: boolean;
}

export function emptyHyrum(): HyrumFlags {
  return {
    errorMessage: false,
    toString: false,
    json: false,
    nan: false,
    sparseArray: false,
    keyOrder: false,
    prototype: false,
    mutation: false,
    dateIdentity: false,
    sameReference: false,
  };
}

export function hashEnvelope(env: Envelope): string {
  const copy = { ...env, traces: [] as TraceEvent[] };
  return createHash("sha256")
    .update(canonical(copy))
    .digest("hex");
}

/** Persist envelopes without traces (those live in traces.jsonl). */
export function envelopeForDisk(env: Envelope): Envelope {
  return { ...env, traces: [] };
}

function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k]);
    return out;
  }
  return value;
}
