import ms from "ms";

export function hourMs(): number {
  return ms("1h") as number;
}

export function formatMs(n: number): string {
  return ms(n);
}
