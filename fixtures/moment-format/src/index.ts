import moment from "moment";

export function ymd(): string {
  return moment(new Date(2020, 0, 15)).format("YYYY-MM-DD");
}

export function ymdIso(): string {
  return moment("2020-01-15").format("YYYY-MM-DD");
}

export function stamp(): number {
  return moment(new Date(2020, 0, 15)).valueOf();
}
