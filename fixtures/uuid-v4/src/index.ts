import { v4 } from "uuid";

export function requestId(): string {
  return v4();
}
