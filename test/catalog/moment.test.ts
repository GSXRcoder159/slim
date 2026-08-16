import assert from "node:assert/strict";
import { describe, it } from "node:test";
import momentOracle from "moment";
import { createMoment, moment } from "../../src/generate/catalog/moment.ts";

describe("moment catalog", () => {
  it("createMoment and moment are the same function", () => {
    assert.equal(createMoment, moment);
  });

  it("wraps a Date and formats the listed tokens in local time", () => {
    const d = new Date(2020, 0, 5, 3, 4, 7, 9);
    const m = moment(d);
    assert.equal(m.format("YYYY-MM-DD HH:mm:ss.SSS"), "2020-01-05 03:04:07.009");
    assert.equal(m.format("M D H m s"), "1 5 3 4 7");
    assert.equal(m.format("A a"), "AM am");
    const pm = moment(new Date(2020, 0, 5, 15, 0, 0, 0));
    assert.equal(pm.format("A a"), "PM pm");
  });

  it("parses ISO strings", () => {
    const m = moment("2020-01-15T12:30:45.123Z");
    assert.equal(m.isValid(), true);
    assert.equal(m.valueOf(), Date.parse("2020-01-15T12:30:45.123Z"));
    assert.equal(moment("2020-01-15").format("YYYY-MM-DD"), "2020-01-15");
  });

  it("unix / valueOf / toDate", () => {
    const d = new Date("2020-01-15T00:00:00.000Z");
    const m = moment(d);
    assert.equal(m.valueOf(), d.getTime());
    assert.equal(m.unix(), Math.floor(d.getTime() / 1000));
    const copy = m.toDate();
    assert.ok(copy instanceof Date);
    assert.equal(copy.getTime(), d.getTime());
    assert.notEqual(copy, d);
  });

  it("accepts epoch milliseconds", () => {
    const ms = Date.UTC(2021, 5, 1, 0, 0, 0, 0);
    assert.equal(moment(ms).valueOf(), ms);
  });

  it("invalid input formats as Invalid date and isValid is false", () => {
    assert.equal(moment(null).isValid(), false);
    assert.equal(moment("not a date").isValid(), false);
    assert.equal(moment("not a date").format("YYYY"), "Invalid date");
    assert.ok(Number.isNaN(moment("nope").valueOf()));
  });

  it("looks up Date.now at call time when wrapping now", () => {
    const original = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      assert.equal(moment().valueOf(), 1_700_000_000_000);
    } finally {
      Date.now = original;
    }
  });

  it("add / subtract days, months, years, hours, minutes, seconds", () => {
    const m = moment(new Date(2020, 0, 15, 12, 0, 0, 0));
    m.add(2, "days");
    assert.equal(m.format("YYYY-MM-DD"), "2020-01-17");
    m.subtract(1, "days");
    assert.equal(m.format("YYYY-MM-DD"), "2020-01-16");
    m.add(1, "months");
    assert.equal(m.format("YYYY-MM-DD"), "2020-02-16");
    m.add(1, "years");
    assert.equal(m.format("YYYY-MM-DD"), "2021-02-16");
    m.add(3, "hours").add(4, "minutes").add(5, "seconds");
    assert.equal(m.format("HH:mm:ss"), "15:04:05");
  });

  it("clips month overflow like Jan 31 + 1 month → end of February", () => {
    const m = moment(new Date(2013, 0, 31));
    m.add(1, "months");
    assert.equal(m.format("YYYY-MM-DD"), "2013-02-28");
  });

  it("mutates and returns the same instance", () => {
    const m = moment(new Date(2020, 0, 1));
    const ret = m.add(1, "days");
    assert.equal(ret, m);
  });

  it("agrees with moment on public format/parse/unix/valueOf/toDate/add/isValid", () => {
    const d = new Date(Date.UTC(2020, 0, 15, 12, 30, 45, 123));
    const slim = moment(d);
    const real = momentOracle(d);
    assert.equal(slim.format("YYYY-MM-DD HH:mm:ss.SSS"), real.format("YYYY-MM-DD HH:mm:ss.SSS"));
    assert.equal(slim.unix(), real.unix());
    assert.equal(slim.valueOf(), real.valueOf());
    assert.equal(slim.toDate().getTime(), real.toDate().getTime());
    assert.equal(slim.isValid(), real.isValid());

    const iso = "2020-01-15T12:30:45.123Z";
    assert.equal(moment(iso).valueOf(), momentOracle(iso).valueOf());
    assert.equal(moment(iso).isValid(), momentOracle(iso).isValid());

    const slimAdd = moment(new Date(2020, 0, 15));
    const realAdd = momentOracle(new Date(2020, 0, 15));
    slimAdd.add(2, "days");
    realAdd.add(2, "days");
    assert.equal(slimAdd.format("YYYY-MM-DD"), realAdd.format("YYYY-MM-DD"));

    assert.equal(moment("not a date").isValid(), momentOracle("not a date").isValid());
    assert.equal(moment("not a date").format("YYYY"), momentOracle("not a date").format("YYYY"));
  });
});
