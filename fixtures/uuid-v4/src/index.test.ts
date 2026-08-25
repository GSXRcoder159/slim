import { test } from "node:test";
import assert from "node:assert/strict";
import { requestId } from "./index.ts";

test("requestId is an RFC 4122 v4 UUID", () => {
  const id = requestId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(requestId(), id);
});
