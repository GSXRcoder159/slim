import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCli, runCli, COMMAND_FLAGS } from "../src/cli.ts";
import { EXIT_OK, EXIT_USAGE } from "../src/exit.ts";
import { validateNamed } from "../src/schema/documents.ts";

async function capture(fn: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

test("replace --json is usage with error document on stdout", async () => {
  const { code, stdout, stderr } = await capture(() => runCli(["replace", "lodash", "--json"]));
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /replace does not support --json/);
  assert.match(stderr, /Usage:/);
  const doc = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(validateNamed("error", doc), null);
  assert.equal(doc.ok, false);
  assert.equal(doc.exit, EXIT_USAGE);
  assert.equal(doc.status, "usage");
});

test("scan --llm is usage", async () => {
  const { code, stdout, stderr } = await capture(() => runCli(["scan", "--llm"]));
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /scan does not support --llm/);
  assert.match(stderr, /Usage:/);
  assert.equal(stdout.trim(), "");
});

test("bloat --json is usage with error document on stdout", async () => {
  const { code, stdout, stderr } = await capture(() => runCli(["bloat", "--json"]));
  assert.equal(code, EXIT_USAGE);
  assert.match(stderr, /bloat does not support --json/);
  assert.match(stderr, /Usage:/);
  const doc = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(validateNamed("error", doc), null);
  assert.equal(doc.ok, false);
  assert.equal(doc.exit, EXIT_USAGE);
  assert.equal(doc.status, "usage");
});

test("JSON commands still accept --json", () => {
  for (const command of ["scan", "inspect", "check", "upstream", "doctor"] as const) {
    assert.ok(COMMAND_FLAGS[command]?.has("json"), command);
    const args = parseCli([command, "--json"]);
    assert.equal(args.command, command);
    assert.equal(args.json, true);
  }
  assert.equal(COMMAND_FLAGS.replace?.has("json"), false);
  assert.equal(COMMAND_FLAGS.bloat?.has("json"), false);
});

test("watch --json is allowed as upstream", async () => {
  const args = parseCli(["watch", "--json"]);
  assert.equal(args.command, "upstream");
  assert.equal(args.json, true);
});

test("doctor --json still emits one document", async () => {
  const { code, stdout } = await capture(() => runCli(["doctor", "--json"]));
  assert.equal(code, EXIT_OK);
  const doc = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(validateNamed("doctor", doc), null);
});
