export const TRACE_SESSION_V = 1 as const;

export type TraceSessionLine = {
  t: "session";
  hook: true;
  v: typeof TRACE_SESSION_V;
};

export type TraceErrorKind = "serialize" | "unresolved-star" | "worker";

export type TraceErrorRecord = {
  t: "error";
  kind: TraceErrorKind | string;
  message?: string;
};

export function sessionRecord(): TraceSessionLine {
  return { t: "session", hook: true, v: TRACE_SESSION_V };
}

export function sessionLine(): string {
  return JSON.stringify(sessionRecord()) + "\n";
}

export function errorRecord(kind: string, message?: string): TraceErrorRecord {
  return message ? { t: "error", kind, message } : { t: "error", kind };
}

export function errorLine(kind: string, message?: string): string {
  return JSON.stringify(errorRecord(kind, message)) + "\n";
}

export function isSessionRecord(v: unknown): v is TraceSessionLine {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.t === "session" && o.hook === true && o.v === TRACE_SESSION_V;
}

export function isErrorRecord(v: unknown): v is TraceErrorRecord {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.t === "error" && typeof o.kind === "string" && o.kind.length > 0;
}
