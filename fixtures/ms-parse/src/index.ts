import ms from "ms";

export function hourMs(): number {
  return ms("1h") as number;
}

export function formatMs(n: number): string {
  return ms(n);
}

export function parseToken(token: string): number {
  return ms(token) as number;
}
