import Database from "better-sqlite3";

export function open(path: string) {
  return new Database(path);
}
