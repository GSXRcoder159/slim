import { test } from "node:test";
import assert from "node:assert/strict";
import { EXIT_ENV, EXIT_REFUSED, SlimExit } from "../src/exit.ts";
import {
  EXPECTED_PACKAGE_NAME,
  EXPECTED_REGISTRY,
  EXPECTED_UNPKG_PREFIX,
  packageNodeModulesDir,
} from "../src/release/identity.ts";
import { assertNpmOccupancy, packumentUrl } from "../src/release/occupancy.ts";

function isSlimExit(err: unknown, code: number, re: RegExp): boolean {
  return err instanceof SlimExit && err.code === code && re.test(err.message);
}

test("canonical package name is scoped and unpkg prefix matches it", () => {
  assert.equal(EXPECTED_PACKAGE_NAME, "@gsxrcoder159/slim");
  assert.equal(EXPECTED_UNPKG_PREFIX, "https://unpkg.com/@gsxrcoder159/slim/");
  assert.equal(
    packageNodeModulesDir("/tmp/host"),
    "/tmp/host/node_modules/@gsxrcoder159/slim",
  );
});

test("packument URL encodes the scoped name", () => {
  assert.equal(
    packumentUrl("@gsxrcoder159/slim", EXPECTED_REGISTRY),
    "https://registry.npmjs.org/@gsxrcoder159%2fslim",
  );
});

test("occupancy 404 means the name and version are free", async () => {
  await assertNpmOccupancy({
    name: "@gsxrcoder159/slim",
    version: "0.1.0",
    fetch: async () => new Response(null, { status: 404 }),
  });
});

test("occupancy refuses when the version already exists on the registry", async () => {
  await assert.rejects(
    () =>
      assertNpmOccupancy({
        name: "@gsxrcoder159/slim",
        version: "0.1.0",
        fetch: async () =>
          new Response(JSON.stringify({ name: "@gsxrcoder159/slim", versions: { "0.1.0": {} } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    (err: unknown) => isSlimExit(err, EXIT_REFUSED, /occupied|already published|version/i),
  );
});

test("occupancy allows a packument that does not contain this version", async () => {
  await assertNpmOccupancy({
    name: "@gsxrcoder159/slim",
    version: "0.1.0",
    fetch: async () =>
      new Response(JSON.stringify({ name: "@gsxrcoder159/slim", versions: { "0.0.1": {} } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
});

test("occupancy with a token requires npm whoami to succeed", async () => {
  await assertNpmOccupancy({
    name: "@gsxrcoder159/slim",
    version: "0.1.0",
    token: "npm_test_token",
    fetch: async () => new Response(null, { status: 404 }),
    whoami: () => "gsxrcoder159",
  });
  await assert.rejects(
    () =>
      assertNpmOccupancy({
        name: "@gsxrcoder159/slim",
        version: "0.1.0",
        token: "npm_test_token",
        fetch: async () => new Response(null, { status: 404 }),
        whoami: () => {
          throw new Error("ENEEDAUTH");
        },
      }),
    (err: unknown) => isSlimExit(err, EXIT_ENV, /whoami|auth|permission/i),
  );
});
