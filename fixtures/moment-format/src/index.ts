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

export function unix(): number {
  return moment(new Date(2020, 0, 15)).unix();
}

export function asDate(): Date {
  return moment(new Date(2020, 0, 15)).toDate();
}

export function shifted(): string {
  return moment(new Date(2020, 0, 15)).add(1, "days").subtract(1, "hours").format("YYYY-MM-DD HH");
}

export function validIso(): boolean {
  return moment("2020-01-15").isValid();
}
