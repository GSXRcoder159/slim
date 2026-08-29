import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hermeticPmEnv, execPm } from "../src/rewrite/lockfile.ts";
import { packSlim } from "./helpers/llm-replace.ts";

type SourceResult = { status: string; value?: unknown; detail: string };

type PackedOsv = {
  queryOsv: (name: string, version: string, fetchImpl: typeof fetch) => Promise<SourceResult>;
};
type PackedNpm = {
  npmLatest: (name: string, fetchImpl: typeof fetch) => Promise<SourceResult>;
};

function jsonResponse(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": "application/json" } });
}

let packDir = "";
let host = "";
let queryOsv: PackedOsv["queryOsv"];
let npmLatest: PackedNpm["npmLatest"];

before(async () => {
  const packed = packSlim();
  packDir = packed.packDir;
  host = mkdtempSync(join(tmpdir(), "slim-up-pack-src-"));
  writeFileSync(join(host, "package.json"), JSON.stringify({ name: "host", private: true }));
  execPm("npm", ["install", packed.tarball, "--omit=dev"], {
    cwd: host,
    encoding: "utf8",
    timeout: 60_000,
    env: hermeticPmEnv(),
  });
  const slimRoot = join(host, "node_modules", "slim");
  const osvMod = (await import(pathToFileURL(join(slimRoot, "dist/upstream/osv.js")).href)) as PackedOsv;
  const npmMod = (await import(pathToFileURL(join(slimRoot, "dist/upstream/npm.js")).href)) as PackedNpm;
  queryOsv = osvMod.queryOsv;
  npmLatest = npmMod.npmLatest;
});

after(() => {
  if (host) rmSync(host, { recursive: true, force: true });
  if (packDir) rmSync(packDir, { recursive: true, force: true });
});

test("packed queryOsv missing vulns is malformed", { timeout: 180_000 }, async () => {
  const r = await queryOsv("lodash", "4.17.21", async () => jsonResponse(200, {}));
  assert.equal(r.status, "malformed");
  assert.match(r.detail, /vulns/i);
  assert.equal(r.value, undefined);
});

test("packed queryOsv empty vulns is success", { timeout: 180_000 }, async () => {
  const r = await queryOsv("lodash", "4.17.21", async () => jsonResponse(200, { vulns: [] }));
  assert.equal(r.status, "success");
  assert.deepEqual(r.value, []);
});

test("packed npmLatest versions array is malformed", { timeout: 180_000 }, async () => {
  const r = await npmLatest("lodash", async () =>
    jsonResponse(200, {
      "dist-tags": { latest: "4.17.21" },
      versions: ["4.17.21"],
      time: { modified: "2020-01-01T00:00:00.000Z" },
    }),
  );
  assert.equal(r.status, "malformed");
  assert.match(r.detail, /versions/i);
});

test("packed npmLatest missing time is malformed", { timeout: 180_000 }, async () => {
  const r = await npmLatest("lodash", async () =>
    jsonResponse(200, { "dist-tags": { latest: "4.17.21" }, versions: { "4.17.21": {} } }),
  );
  assert.equal(r.status, "malformed");
  assert.match(r.detail, /time/i);
});

test("packed npmLatest success requires versions and time", { timeout: 180_000 }, async () => {
  const r = await npmLatest("lodash", async () =>
    jsonResponse(200, {
      "dist-tags": { latest: "4.17.21" },
      versions: { "4.17.20": {}, "4.17.21": {} },
      time: { modified: "2020-01-01T00:00:00.000Z" },
    }),
  );
  assert.equal(r.status, "success");
  assert.equal((r.value as { version: string }).version, "4.17.21");
});
