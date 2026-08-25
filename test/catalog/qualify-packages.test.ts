import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import momentOracle from "moment";
import clsxOracle from "clsx";
import msOracle from "ms";
import { v4 as uuidOracle } from "uuid";
import { nanoid as nanoidOracle, customAlphabet as customAlphabetOracle } from "nanoid";
import Bluebird from "bluebird";
import mimeOracle from "mime-types";
import * as whatwgOracle from "whatwg-url";
import { CATALOG_ORACLES } from "../../src/generate/catalog/index.ts";
import { moment } from "../../src/generate/catalog/moment.ts";
import clsx from "../../src/generate/catalog/clsx.ts";
import ms from "../../src/generate/catalog/ms.ts";
import { v4 } from "../../src/generate/catalog/uuid.ts";
import { nanoid, customAlphabet } from "../../src/generate/catalog/nanoid.ts";
import { URL as CatalogURL, URLSearchParams as CatalogURLSearchParams } from "../../src/generate/catalog/whatwgUrl.ts";
import { resolve, all, delay, promisify } from "../../src/generate/catalog/bluebird.ts";
import { lookup, extension, MIME_LOOKUP_EXTS, MIME_EXTENSION_TYPES } from "../../src/generate/catalog/mimeTypes.ts";
import { runFuzz } from "../../src/fuzz/run.ts";
import { catalogEnvelope } from "./qualify-helpers.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function oracleVersion(pkg: string): string {
  const pkgJson = join(ROOT, "node_modules", pkg, "package.json");
  return (JSON.parse(readFileSync(pkgJson, "utf8")) as { version: string }).version;
}

async function assertFuzz(
  name: string,
  original: Record<string, Function>,
  replacement: Record<string, Function>,
  envelope: ReturnType<typeof catalogEnvelope>,
  budgetMs = 350,
): Promise<void> {
  const report = await runFuzz({
    original,
    replacement,
    envelope,
    budgetMs,
    seed: 21,
    workers: 1,
  });
  assert.equal(
    report.disagreements.length,
    0,
    `${name}: ${report.disagreements.map((d) => `${d.symbol} ${d.reason}`).join("; ")}`,
  );
  assert.ok(report.comparisons > 0, `${name}: expected comparisons`);
}

describe("catalog oracle pins", () => {
  it("every CATALOG_ORACLES pin is installed at that exact version", () => {
    for (const [pkg, pin] of Object.entries(CATALOG_ORACLES)) {
      assert.equal(oracleVersion(pkg), pin, `${pkg} must be ${pin}`);
    }
  });
});

describe("package-level catalog qualification", () => {
  it("moment format/parse/unix agrees with the pinned oracle via runFuzz", async () => {
    const env = catalogEnvelope({
      name: "moment",
      version: CATALOG_ORACLES.moment,
      symbols: ["default"],
      importKind: "default",
      resultMembers: { default: ["format", "unix", "valueOf", "toDate", "isValid"] },
    });
    env.symbols[0]!.callSites[0]!.argc = { min: 1, max: 1, observed: [1] };
    env.symbols[0]!.callSites[0]!.argShapes = [
      {
        kind: "literal",
        literals: ["2020-01-15T12:30:45.123Z", "not a date", 1_578_960_000_000],
      },
    ];
    const slimFormat = (input: unknown) => moment(input as never).format("YYYY-MM-DD");
    const origFormat = (input: unknown) => momentOracle(input as never).format("YYYY-MM-DD");
    await assertFuzz("moment", { default: origFormat }, { default: slimFormat }, env, 0);
  });

  it("clsx agrees with the pinned oracle via runFuzz", async () => {
    const env = catalogEnvelope({
      name: "clsx",
      version: CATALOG_ORACLES.clsx,
      symbols: ["clsx"],
    });
    env.symbols[0]!.callSites[0]!.argc = { min: 1, max: 3, observed: [1, 2, 3] };
    env.symbols[0]!.callSites[0]!.argShapes = [
      { kind: "literal", literals: ["foo", { bar: true, baz: false }, ["a", "b"]] },
      { kind: "literal", literals: ["x", null, { y: 1 }] },
      { kind: "literal", literals: [0, "z"] },
    ];
    await assertFuzz("clsx", { clsx: clsxOracle }, { clsx }, env);
  });

  it("ms agrees with the pinned oracle via runFuzz", async () => {
    const env = catalogEnvelope({
      name: "ms",
      version: CATALOG_ORACLES.ms,
      symbols: ["ms"],
    });
    env.symbols[0]!.callSites[0]!.argc = { min: 1, max: 1, observed: [1] };
    env.symbols[0]!.callSites[0]!.argShapes = [
      {
        kind: "literal",
        literals: ["1h", "2 days", "1h 30m", "100", 1000, -1000, ""],
      },
    ];
    await assertFuzz("ms", { ms: msOracle as unknown as Function }, { ms: ms as unknown as Function }, env);
  });

  it("uuid v4 agrees with the pinned oracle via runFuzz", async () => {
    const env = catalogEnvelope({
      name: "uuid",
      version: CATALOG_ORACLES.uuid,
      symbols: ["v4"],
      cryptoRandom: true,
    });
    await assertFuzz("uuid", { v4: uuidOracle }, { v4 }, env);
  });

  it("nanoid and customAlphabet first-output agree with the pinned oracle", async () => {
    const env = catalogEnvelope({
      name: "nanoid",
      version: CATALOG_ORACLES.nanoid,
      symbols: ["nanoid"],
      cryptoRandom: true,
    });
    env.symbols[0]!.callSites[0]!.argc = { min: 0, max: 1, observed: [0, 1] };
    env.symbols[0]!.callSites[0]!.argShapes = [{ kind: "literal", literals: [10, 21] }];
    await assertFuzz("nanoid", { nanoid: nanoidOracle }, { nanoid }, env);

    const alphabet = "abcdefghijklmnopqrstuvwxyz";
    const slimFactory = customAlphabet(alphabet, 8);
    const origFactory = customAlphabetOracle(alphabet, 8);
    const slimOut = slimFactory();
    const origOut = origFactory();
    assert.equal(typeof slimOut, "string");
    assert.equal(slimOut.length, origOut.length);
  });

  it("whatwg-url URL/URLSearchParams match globalThis and the pinned package on the allowlisted API", async () => {
    assert.equal(CatalogURL, globalThis.URL);
    assert.equal(CatalogURLSearchParams, globalThis.URLSearchParams);
    const href = "https://example.com/path?q=1#hash";
    assert.equal(new CatalogURL(href).hostname, new globalThis.URL(href).hostname);
    assert.equal(new CatalogURL(href).hostname, new (whatwgOracle.URL as typeof URL)(href).hostname);
    const env = catalogEnvelope({
      name: "whatwg-url",
      version: CATALOG_ORACLES["whatwg-url"],
      symbols: ["URL"],
    });
    env.symbols[0]!.callSites[0]!.argc = { min: 1, max: 1, observed: [1] };
    env.symbols[0]!.callSites[0]!.argShapes = [
      { kind: "literal", literals: ["https://example.com/", "https://x.test/a?b=1"] },
    ];
    await assertFuzz(
      "whatwg-url",
      { URL: globalThis.URL as unknown as Function },
      { URL: CatalogURL as unknown as Function },
      env,
    );
  });

  it("bluebird resolve/all/delay agree with the pinned oracle", async () => {
    assert.equal(await resolve(7), await Bluebird.resolve(7));
    assert.equal(await resolve("ok"), await Bluebird.resolve("ok"));
    assert.deepEqual(await all([1, Promise.resolve(2)]), await Bluebird.all([1, Promise.resolve(2)]));
    assert.equal(await delay(0, 7), await Bluebird.delay(0, 7));
    const env = catalogEnvelope({
      name: "bluebird",
      version: CATALOG_ORACLES.bluebird,
      symbols: ["promisify"],
    });
    env.symbols[0]!.callSites[0]!.argc = { min: 1, max: 1, observed: [1] };
    env.symbols[0]!.callSites[0]!.argShapes = [{ kind: "function", fnArity: 2 }];
    const slimKind = (x: unknown) => {
      try {
        return typeof promisify(x as never);
      } catch (e) {
        return e instanceof Error ? e.name : "throw";
      }
    };
    const origKind = (x: unknown) => {
      try {
        return typeof Bluebird.promisify(x as never);
      } catch (e) {
        return e instanceof Error ? e.name : "throw";
      }
    };
    await assertFuzz("bluebird", { promisify: origKind }, { promisify: slimKind }, env, 50);
  });

  it("mime-types allowlisted keys equal the pinned oracle", async () => {
    const mime = mimeOracle as unknown as {
      lookup: (path: string) => string | false;
      extension: (type: string) => string | false;
    };
    for (const ext of MIME_LOOKUP_EXTS) {
      assert.equal(lookup(ext), mime.lookup(ext), `lookup(${ext})`);
      assert.equal(lookup(`.${ext}`), mime.lookup(`.${ext}`), `lookup(.${ext})`);
    }
    for (const type of MIME_EXTENSION_TYPES) {
      assert.equal(extension(type), mime.extension(type), `extension(${type})`);
    }
    const env = catalogEnvelope({
      name: "mime-types",
      version: CATALOG_ORACLES["mime-types"],
      symbols: ["lookup"],
    });
    env.symbols[0]!.callSites[0]!.argc = { min: 1, max: 1, observed: [1] };
    env.symbols[0]!.callSites[0]!.argShapes = [
      { kind: "literal", literals: [...MIME_LOOKUP_EXTS].slice(0, 8) },
    ];
    await assertFuzz(
      "mime-types",
      { lookup: mime.lookup.bind(mime) },
      { lookup },
      env,
    );
  });
});
