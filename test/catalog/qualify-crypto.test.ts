import assert from "node:assert/strict";
import { test } from "node:test";
import { v4 as uuidV4 } from "uuid";
import { nanoid as nanoidOracle } from "nanoid";
import { v4 } from "../../src/generate/catalog/uuid.ts";
import { nanoid } from "../../src/generate/catalog/nanoid.ts";
import { runFuzz } from "../../src/fuzz/run.ts";
import { catalogEnvelope } from "./qualify-helpers.ts";
import { CATALOG_ORACLES } from "../../src/generate/catalog/index.ts";

test("uuid v4 package-level fuzz agrees with the pinned oracle", async () => {
  const envelope = catalogEnvelope({
    name: "uuid",
    version: CATALOG_ORACLES.uuid,
    symbols: ["v4"],
    cryptoRandom: true,
  });
  const report = await runFuzz({
    original: { v4: uuidV4 },
    replacement: { v4 },
    envelope,
    budgetMs: 400,
    seed: 11,
    workers: 1,
  });
  assert.equal(
    report.disagreements.length,
    0,
    report.disagreements.map((d) => d.reason).join("; "),
  );
  assert.ok(report.comparisons > 0);
});

test("nanoid package-level fuzz agrees with the pinned oracle", async () => {
  const envelope = catalogEnvelope({
    name: "nanoid",
    version: CATALOG_ORACLES.nanoid,
    symbols: ["nanoid"],
    cryptoRandom: true,
  });
  envelope.symbols[0]!.callSites[0]!.argc = { min: 0, max: 1, observed: [0, 1] };
  envelope.symbols[0]!.callSites[0]!.argShapes = [
    { kind: "literal", literals: [10, 21] },
  ];
  const report = await runFuzz({
    original: { nanoid: nanoidOracle },
    replacement: { nanoid },
    envelope,
    budgetMs: 400,
    seed: 13,
    workers: 1,
  });
  assert.equal(
    report.disagreements.length,
    0,
    report.disagreements.map((d) => `${d.symbol}: ${d.reason}`).join("; "),
  );
  assert.ok(report.comparisons > 0);
});
