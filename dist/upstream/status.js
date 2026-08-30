export const FETCH_MS = 15_000;
export function sourceOk(value, detail = "ok") {
    return { status: "success", value, detail };
}
export function sourceErr(status, detail) {
    return { status, detail };
}
export function sourceNotRequired() {
    return { status: "success", detail: "not required" };
}
export function isConsultedFailure(s) {
    return s.detail !== "not required" && s.status !== "success";
}
export function cmpVersion(a, b) {
    const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
    const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d)
            return d;
    }
    return 0;
}
export async function fetchJson(url, init = {}, fetchImpl = fetch) {
    let res;
    try {
        res = await fetchImpl(url, {
            ...init,
            signal: init.signal ?? AbortSignal.timeout(FETCH_MS),
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const name = err instanceof Error ? err.name : "";
        const timeout = /timeout|aborted|abort/i.test(msg) || name === "TimeoutError" || name === "AbortError";
        return sourceErr(timeout ? "timeout" : "unavailable", timeout ? `timeout: ${msg}` : msg);
    }
    if (!res.ok) {
        return sourceErr("unavailable", `HTTP ${res.status}`);
    }
    let text;
    try {
        text = await res.text();
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return sourceErr("unavailable", msg);
    }
    try {
        return sourceOk(JSON.parse(text));
    }
    catch {
        return sourceErr("malformed", "response is not JSON");
    }
}
//# sourceMappingURL=status.js.map