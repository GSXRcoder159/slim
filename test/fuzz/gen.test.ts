import { test } from "node:test";
import assert from "node:assert/strict";
import { createGen, enumerateLiteralUnions, fromShapes, isExportTrace, pickObservedArgc } from "../../src/fuzz/gen.ts";

test("fromShapes uses array elements as a tuple", () => {
  const args = fromShapes(
    [{ kind: "array", elements: [{ kind: "literal", literals: ["ELEM_ONLY"] }] }],
    createGen(1),
  );
  assert.deepEqual(args, [["ELEM_ONLY"]]);
});

test("fromShapes honors argc shorter than the shape list", () => {
  const shapes = [
    { kind: "literal" as const, literals: ["a"] },
    { kind: "literal" as const, literals: ["b"] },
    { kind: "literal" as const, literals: ["c"] },
  ];
  assert.deepEqual(fromShapes(shapes, createGen(1), 2), ["a", "b"]);
  assert.equal(fromShapes(shapes, createGen(1), 2).length, 2);
});

test("isExportTrace skips result-member ops", () => {
  assert.equal(isExportTrace({ symbol: "debounce", args: [] }), true);
  assert.equal(
    isExportTrace({ symbol: "debounce.flush", args: [], parentOriginId: "p", resultMember: "flush" }),
    false,
  );
  assert.equal(
    isExportTrace({ symbol: "debounce()", args: [], parentOriginId: "p", resultMember: "" }),
    false,
  );
});

test("enumerateLiteralUnions only expands shapes that already have literals", () => {
  assert.deepEqual(
    enumerateLiteralUnions(
      [
        { kind: "literal", literals: ["https://example.com/"] },
        { kind: "literal", literals: [1, 2] },
      ],
      8,
    ),
    [
      ["https://example.com/", 1],
      ["https://example.com/", 2],
    ],
  );
  assert.deepEqual(enumerateLiteralUnions([{ kind: "any" }], 8), []);
  assert.deepEqual(enumerateLiteralUnions([{ kind: "literal", literals: ["a"] }, { kind: "any" }], 8), []);
});

test("pickObservedArgc uses the observed list", () => {
  const gen = createGen(3);
  const n = pickObservedArgc([2], gen, 3);
  assert.equal(n, 2);
  assert.equal(pickObservedArgc([], gen, 4), 4);
});
