import moment from "moment";

export function ymd(d: Date | string): string {
  return moment(d).format("YYYY-MM-DD");
}

export function stamp(d: Date): number {
  return moment(d).valueOf();
}
