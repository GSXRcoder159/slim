#!/usr/bin/env node
/**
 * Release identity and artifact gate. Publish only the qualified tarball.
 */
import { parseArgs } from "node:util";
import { EXIT_USAGE, SlimExit } from "../src/exit.ts";
import { runReleaseGate, type GateMode } from "../src/release/gate.ts";
import { repoRootFromScript } from "./build.mjs";

const MODES = new Set<GateMode>(["identity", "artifacts", "rehearse", "publish"]);

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "identity" },
    tag: { type: "string" },
    tarball: { type: "string" },
    receipts: { type: "string" },
    bundle: { type: "string" },
    commit: { type: "string" },
    "workflow-run": { type: "string" },
    registry: { type: "string" },
    root: { type: "string" },
    "parent-sha": { type: "string" },
    remote: { type: "string" },
    "delete-tarball": { type: "boolean", default: false },
  },
});

const mode = values.mode ?? "identity";
if (!MODES.has(mode as GateMode)) {
  process.stderr.write(`release-gate: unknown mode ${mode}\n`);
  process.exit(EXIT_USAGE);
}

const root = values.root ?? repoRootFromScript();

try {
  const result = await runReleaseGate({
    root,
    mode: mode as GateMode,
    tag: values.tag,
    tarball: values.tarball,
    receiptsDir: values.receipts,
    bundleDir: values.bundle,
    commit: values.commit,
    workflowRun: values["workflow-run"] ?? null,
    registryUrl: values.registry,
    parentSha: values["parent-sha"],
    remote: values.remote,
    deleteTarball: values["delete-tarball"] === true,
  });
  process.stdout.write(
    `release-gate: ${result.tag} npm=${result.npmDigest ?? "-"} action=${result.actionDigest ?? "-"} publication=${result.publication} rollback=${result.rollback}\n`,
  );
} catch (err) {
  const code = err instanceof SlimExit ? err.code : 1;
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`release-gate: ${msg}\n`);
  process.exit(code);
}
