export const TRACE_SESSION_V = 1;
export function sessionRecord() {
    return { t: "session", hook: true, v: TRACE_SESSION_V };
}
export function sessionLine() {
    return JSON.stringify(sessionRecord()) + "\n";
}
export function errorRecord(kind, message) {
    return message ? { t: "error", kind, message } : { t: "error", kind };
}
export function errorLine(kind, message) {
    return JSON.stringify(errorRecord(kind, message)) + "\n";
}
export function isSessionRecord(v) {
    if (!v || typeof v !== "object")
        return false;
    const o = v;
    return o.t === "session" && o.hook === true && o.v === TRACE_SESSION_V;
}
export function isErrorRecord(v) {
    if (!v || typeof v !== "object")
        return false;
    const o = v;
    return o.t === "error" && typeof o.kind === "string" && o.kind.length > 0;
}
//# sourceMappingURL=session.js.map