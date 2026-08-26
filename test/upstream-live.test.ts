import { test } from "node:test";
import assert from "node:assert/strict";
import { queryOsv } from "../src/upstream/osv.ts";
import { npmLatest } from "../src/upstream/npm.ts";
import { fetchJson } from "../src/upstream/status.ts";

const osvLive = process.env.SLIM_OSV_LIVE === "1";
const npmLive = process.env.SLIM_NPM_LIVE === "1";

if (osvLive) {
  test("live OSV query for lodash@4.17.21 succeeds", async () => {
    const r = await queryOsv("lodash", "4.17.21");
    assert.equal(r.status, "success", r.detail);
    assert.ok(Array.isArray(r.value));
  });
}

if (npmLive) {
  test("live npm registry packument for lodash returns a semver", async () => {
    const r = await npmLatest("lodash");
    assert.equal(r.status, "success", r.detail);
    assert.match(r.value?.version ?? "", /^\d+\.\d+\.\d+/);
  });
}

test("simulated OSV 503 is unavailable", async () => {
  const r = await fetchJson("https://api.osv.dev/v1/query", { method: "POST" }, async () =>
    new Response("down", { status: 503 }),
  );
  assert.equal(r.status, "unavailable");
  assert.match(r.detail, /HTTP 503/);
});
