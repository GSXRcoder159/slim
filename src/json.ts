import { EXIT_ENV, EXIT_OK, EXIT_REFUSED, EXIT_USAGE } from "./exit.ts";

export const JSON_SCHEMA_VERSION = 1 as const;

export type CliStatus = "ok" | "fail" | "usage" | "refused" | "env";

export function statusFromExit(code: number): CliStatus {
  if (code === EXIT_OK) return "ok";
  if (code === EXIT_USAGE) return "usage";
  if (code === EXIT_REFUSED) return "refused";
  if (code === EXIT_ENV) return "env";
  return "fail";
}

export function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

export function errorDocument(exit: number, error: string): {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  ok: false;
  exit: number;
  status: CliStatus;
  error: string;
} {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    ok: false,
    exit,
    status: statusFromExit(exit),
    error,
  };
}
