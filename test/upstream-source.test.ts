import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchJson, cmpVersion, sourceOk, sourceErr, isConsultedFailure } from "../src/upstream/status.ts";
import { queryOsv } from "../src/upstream/osv.ts";
import { npmLatest } from "../src/upstream/npm.ts";

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
}

test("cmpVersion orders dotted numeric versions", () => {
  assert.ok(cmpVersion("4.17.22", "4.17.21") > 0);
  assert.ok(cmpVersion("4.17.21", "4.17.22") < 0);
  assert.equal(cmpVersion("4.17.21", "4.17.21"), 0);
});

test("isConsultedFailure ignores not-required success", () => {
  assert.equal(isConsultedFailure({ status: "success", detail: "not required" }), false);
  assert.equal(isConsultedFailure({ status: "success", detail: "ok" }), false);
  assert.equal(isConsultedFailure({ status: "unavailable", detail: "HTTP 503" }), true);
  assert.equal(isConsultedFailure({ status: "malformed", detail: "no version" }), true);
  assert.equal(isConsultedFailure({ status: "stale", detail: "older than pin" }), true);
});

test("fetchJson HTTP 503 is unavailable", async () => {
  const r = await fetchJson("https://api.osv.dev/v1/query", { method: "POST" }, async () =>
    jsonResponse(503, "down"),
  );
  assert.equal(r.status, "unavailable");
  assert.match(r.detail, /HTTP 503/);
  assert.equal(r.value, undefined);
});

test("fetchJson timeout is unavailable", async () => {
  const r = await fetchJson("https://api.osv.dev/v1/query", {}, async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  assert.equal(r.status, "unavailable");
  assert.match(r.detail, /timeout/i);
});

test("fetchJson network error is unavailable", async () => {
  const r = await fetchJson("https://api.osv.dev/v1/query", {}, async () => {
    throw new TypeError("fetch failed");
  });
  assert.equal(r.status, "unavailable");
  assert.match(r.detail, /fetch failed/);
});

test("fetchJson non-JSON 200 is malformed", async () => {
  const r = await fetchJson("https://api.osv.dev/v1/query", {}, async () => jsonResponse(200, "not-json"));
  assert.equal(r.status, "malformed");
  assert.match(r.detail, /not JSON/);
});

test("fetchJson 200 JSON is success", async () => {
  const r = await fetchJson("https://example.test/", {}, async () => jsonResponse(200, { ok: true }));
  assert.equal(r.status, "success");
  assert.deepEqual(r.value, { ok: true });
});

test("queryOsv HTTP 503 is unavailable, not an empty vuln list", async () => {
  const r = await queryOsv("lodash", "4.17.21", async () => jsonResponse(503, { error: "no" }));
  assert.equal(r.status, "unavailable");
  assert.equal(r.value, undefined);
});

test("queryOsv malformed vulns field is malformed", async () => {
  const r = await queryOsv("lodash", "4.17.21", async () => jsonResponse(200, { vulns: "nope" }));
  assert.equal(r.status, "malformed");
});

test("queryOsv empty vulns is success with []", async () => {
  const r = await queryOsv("lodash", "4.17.21", async () => jsonResponse(200, { vulns: [] }));
  assert.equal(r.status, "success");
  assert.deepEqual(r.value, []);
});

test("queryOsv missing vulns is success with []", async () => {
  const r = await queryOsv("lodash", "4.17.21", async () => jsonResponse(200, {}));
  assert.equal(r.status, "success");
  assert.deepEqual(r.value, []);
});

test("queryOsv returns advisories with affected ranges", async () => {
  const r = await queryOsv("lodash", "4.17.21", async () =>
    jsonResponse(200, {
      vulns: [
        {
          id: "GHSA-x",
          summary: "pollution",
          affected: [
            {
              package: { name: "lodash", ecosystem: "npm" },
              ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
              versions: ["4.17.20"],
            },
          ],
        },
      ],
    }),
  );
  assert.equal(r.status, "success");
  assert.equal(r.value?.[0]?.id, "GHSA-x");
  assert.ok(r.value?.[0]?.affected?.[0]?.ranges?.length);
});

test("npmLatest HTTP 404 is unavailable", async () => {
  const r = await npmLatest("no-such-pkg-xyz", async () => jsonResponse(404, "not found"));
  assert.equal(r.status, "unavailable");
  assert.equal(r.value, undefined);
});

test("npmLatest missing version is malformed", async () => {
  const r = await npmLatest("lodash", async () => jsonResponse(200, { name: "lodash" }));
  assert.equal(r.status, "malformed");
});

test("npmLatest non-string version is malformed", async () => {
  const r = await npmLatest("lodash", async () => jsonResponse(200, { version: 1 }));
  assert.equal(r.status, "malformed");
});

test("npmLatest success returns version and version list", async () => {
  const r = await npmLatest("lodash", async () =>
    jsonResponse(200, {
      "dist-tags": { latest: "4.17.21" },
      versions: { "4.17.20": {}, "4.17.21": {} },
      time: { modified: "2020-01-01" },
    }),
  );
  assert.equal(r.status, "success");
  assert.equal(r.value?.version, "4.17.21");
  assert.deepEqual(r.value?.versions?.sort(), ["4.17.20", "4.17.21"]);
});

test("npmLatest /latest document with version field succeeds", async () => {
  const r = await npmLatest("lodash", async () => jsonResponse(200, { version: "4.17.21", time: { modified: "t" } }));
  assert.equal(r.status, "success");
  assert.equal(r.value?.version, "4.17.21");
});

test("sourceOk / sourceErr helpers", () => {
  assert.deepEqual(sourceOk(["a"]), { status: "success", value: ["a"], detail: "ok" });
  assert.deepEqual(sourceErr("stale", "older"), { status: "stale", detail: "older" });
});
