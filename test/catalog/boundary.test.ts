import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { catalogBoundary } from "../../src/generate/catalog/boundary.ts";
import { catalogEnvelope } from "./qualify-helpers.ts";

describe("catalogBoundary", () => {
  it("refuses lodash.template as envelope-too-wide even though the family is cataloged", () => {
    const env = catalogEnvelope({
      name: "lodash",
      version: "4.17.21",
      symbols: ["get", "template"],
    });
    const r = catalogBoundary(env, "lodash");
    assert.ok(r);
    assert.equal(r.why, "envelope-too-wide");
    assert.match(r.evidence, /template/);
    assert.match(r.whatToDo, /slim replace lodash/);
  });

  it("refuses moment.locale result members", () => {
    const env = catalogEnvelope({
      name: "moment",
      version: "2.30.1",
      symbols: ["default"],
      resultMembers: { default: ["format", "locale"] },
    });
    const r = catalogBoundary(env, "moment");
    assert.ok(r);
    assert.equal(r.why, "envelope-too-wide");
    assert.match(r.evidence, /locale/);
  });

  it("allows moment format/valueOf", () => {
    const env = catalogEnvelope({
      name: "moment",
      version: "2.30.1",
      symbols: ["default"],
      resultMembers: { default: ["format", "valueOf"] },
    });
    assert.equal(catalogBoundary(env, "moment"), null);
  });

  it("refuses uuid v7", () => {
    const env = catalogEnvelope({
      name: "uuid",
      version: "11.1.0",
      symbols: ["v7"],
    });
    const r = catalogBoundary(env, "uuid");
    assert.ok(r);
    assert.match(r.evidence, /v7/);
  });

  it("refuses bluebird.map", () => {
    const env = catalogEnvelope({
      name: "bluebird",
      version: "3.7.2",
      symbols: ["map"],
    });
    const r = catalogBoundary(env, "bluebird");
    assert.ok(r);
    assert.match(r.evidence, /map/);
  });

  it("refuses mime-types lookup of an extension outside the allowlist", () => {
    const env = catalogEnvelope({
      name: "mime-types",
      version: "2.1.35",
      symbols: ["lookup"],
    });
    env.symbols[0]!.callSites[0]!.argShapes = [
      { kind: "literal", literals: ["file.exe"] },
    ];
    const r = catalogBoundary(env, "mime-types");
    assert.ok(r);
    assert.match(r.evidence, /\.exe|file\.exe/);
  });

  it("allows mime-types lookup of json", () => {
    const env = catalogEnvelope({
      name: "mime-types",
      version: "2.1.35",
      symbols: ["lookup"],
    });
    env.symbols[0]!.callSites[0]!.argShapes = [
      { kind: "literal", literals: ["file.json"] },
    ];
    assert.equal(catalogBoundary(env, "mime-types"), null);
  });

  it("refuses whatwg-url parseURL", () => {
    const env = catalogEnvelope({
      name: "whatwg-url",
      version: "14.2.0",
      symbols: ["parseURL"],
    });
    const r = catalogBoundary(env, "whatwg-url");
    assert.ok(r);
    assert.match(r.evidence, /parseURL/);
  });

  it("does not refuse unknown packages (LLM path)", () => {
    const env = catalogEnvelope({
      name: "validator",
      version: "13.0.0",
      symbols: ["isEmail"],
    });
    assert.equal(catalogBoundary(env, "validator"), null);
  });
});
