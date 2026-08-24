export const TRACE_SESSION_V = 1 as const;

export type TraceSessionLine = {
  t: "session";
  hook: true;
  v: typeof TRACE_SESSION_V;
};

export function sessionRecord(): TraceSessionLine {
  return { t: "session", hook: true, v: TRACE_SESSION_V };
}

export function sessionLine(): string {
  return JSON.stringify(sessionRecord()) + "\n";
}

export function isSessionRecord(v: unknown): v is TraceSessionLine {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.t === "session" && o.hook === true;
}
