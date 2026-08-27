import { test } from "node:test";
import assert from "node:assert/strict";
import * as slim from "./lodash.ts";

test("hardened get/set ignore __proto__ and do not pollute Object.prototype", () => {
  const get = (slim as { get?: Function }).get;
  const set = (slim as { set?: Function }).set;
  if (typeof get !== "function" && typeof set !== "function") return;
  const proto = Object.prototype as { polluted?: unknown };
  const before = Object.prototype.hasOwnProperty("polluted");
  delete proto.polluted;
  try {
    if (typeof set === "function") {
      set({}, "__proto__.polluted", true);
      set({}, ["__proto__", "polluted"], true);
    }
    if (typeof get === "function") {
      get({ a: 1 }, "__proto__.polluted");
    }
    assert.equal(Object.prototype.hasOwnProperty("polluted"), before);
    assert.equal(proto.polluted, undefined);
    assert.equal(({} as { polluted?: unknown }).polluted, undefined);
  } finally {
    delete proto.polluted;
  }
});
