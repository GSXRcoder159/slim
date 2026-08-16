import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { extension, lookup } from "../../src/generate/catalog/mimeTypes.ts";

describe("mime-types catalog", () => {
  it("looks up common web extensions from a path or bare ext", () => {
    assert.equal(lookup("index.html"), "text/html");
    assert.equal(lookup("style.css"), "text/css");
    assert.equal(lookup("app.js"), "application/javascript");
    assert.equal(lookup("json"), "application/json");
    assert.equal(lookup(".json"), "application/json");
    assert.equal(lookup("folder/file.png"), "image/png");
    assert.equal(lookup("pic.JPG"), "image/jpeg");
    assert.equal(lookup("a.gif"), "image/gif");
    assert.equal(lookup("icon.svg"), "image/svg+xml");
    assert.equal(lookup("f.woff"), "font/woff");
    assert.equal(lookup("f.woff2"), "font/woff2");
    assert.equal(lookup("mod.wasm"), "application/wasm");
    assert.equal(lookup("notes.txt"), "text/plain");
    assert.equal(lookup("doc.xml"), "application/xml");
    assert.equal(lookup("spec.pdf"), "application/pdf");
  });

  it("returns false for unknown or empty input", () => {
    assert.equal(lookup("file.unknown"), false);
    assert.equal(lookup(""), false);
    assert.equal(lookup(null as unknown as string), false);
  });

  it("documents envelope-driven mime-db as a later ponytail", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../src/generate/catalog/mimeTypes.ts"),
      "utf8",
    );
    assert.match(src, /\/\/ ponytail: envelope-driven mime-db later/);
  });

  it("maps MIME types back to a preferred extension", () => {
    assert.equal(extension("text/html"), "html");
    assert.equal(extension("application/javascript"), "js");
    assert.equal(extension("application/json"), "json");
    assert.equal(extension("image/jpeg"), "jpg");
    assert.equal(extension("text/html; charset=utf-8"), "html");
    assert.equal(extension("no/such"), false);
    assert.equal(extension(""), false);
  });
});
