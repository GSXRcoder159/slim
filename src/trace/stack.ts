import { fileURLToPath } from "node:url";

export type UserSite = { file: string; line: number; column: number };

const SKIP =
  /(?:^|\/)(?:src|dist)\/trace\/|(?:^|\/)node:internal|\/node_modules\/(?:vite|vitest|chai|tinypool|@vitest)\//;

export function captureUserSite(): UserSite | null {
  const prev = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (_err, frames) => frames;
    const err = new Error();
    Error.captureStackTrace(err, captureUserSite);
    const frames = err.stack as unknown as NodeJS.CallSite[] | string;
    if (Array.isArray(frames)) {
      for (const f of frames) {
        const hit = fromCallSite(f);
        if (hit) return hit;
      }
      return null;
    }
    return parseTextStack(String(frames ?? ""));
  } catch {
    return null;
  } finally {
    Error.prepareStackTrace = prev;
  }
}

function fromCallSite(f: NodeJS.CallSite): UserSite | null {
  const raw = f.getFileName();
  if (!raw) return null;
  const file = normalizeFile(raw);
  if (!file || SKIP.test(file)) return null;
  const line = f.getLineNumber() ?? 0;
  const column = f.getColumnNumber() ?? 0;
  if (line <= 0) return null;
  return { file, line, column };
}

function parseTextStack(text: string): UserSite | null {
  for (const line of text.split("\n")) {
    const m = line.match(/\(?((?:file:\/\/)?[^\s)]+):(\d+):(\d+)\)?$/);
    if (!m) continue;
    const file = normalizeFile(m[1]!);
    if (!file || SKIP.test(file)) continue;
    return { file, line: Number(m[2]), column: Number(m[3]) };
  }
  return null;
}

function normalizeFile(raw: string): string {
  let s = raw.replace(/\\/g, "/");
  if (s.startsWith("file:")) {
    try {
      s = fileURLToPath(s).replace(/\\/g, "/");
    } catch {
      /* keep */
    }
  }
  return s.replace(/\?.*$/, "");
}
