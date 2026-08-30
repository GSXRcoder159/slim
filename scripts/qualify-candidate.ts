#!/usr/bin/env node
/**
 * Qualify one candidate commit: identity, pack, local emit, optional live, receipts.
 */
import { parseArgs } from "node:util";
import { EXIT_USAGE, SlimExit } from "../src/exit.ts";
import {
  requireCommit,
  runQualifyCandidate,
  throwIfUnqualified,
  type QualifyMode,
} from "../src/support/qualify-candidate.ts";
import { repoRootFromScript } from "./build.mjs";

const MODES = new Set<QualifyMode>(["emit", "collect"]);

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "emit" },
    receipts: { type: "string" },
    commit: { type: "string" },
    "npm-digest": { type: "string" },
    "action-digest": { type: "string" },
    from: { type: "string" },
    "os-node-only": { type: "boolean", default: false },
    "workflow-run": { type: "string" },
    root: { type: "string" },
    registry: { type: "string" },
  },
});

const mode = (values.mode ?? "emit") as QualifyMode;
if (!MODES.has(mode)) {
  process.stderr.write(`qualify-candidate: unknown mode ${mode}\n`);
  process.exit(EXIT_USAGE);
}

try {
  const commit = requireCommit(values.commit ?? process.env.SLIM_CANDIDATE_COMMIT);
  const osNodeOnly = values["os-node-only"] === true;
  const workflowRun =
    values["workflow-run"] ?? process.env.SLIM_WORKFLOW_RUN ?? process.env.GITHUB_RUN_ID ?? null;
  if (mode === "collect" && !osNodeOnly && !workflowRun) {
    throw new SlimExit(EXIT_USAGE, "qualify-candidate: --workflow-run is required");
  }
  const result = runQualifyCandidate({
    root: values.root ?? repoRootFromScript(),
    mode,
    receiptsDir: values.receipts ?? "qualification/receipts",
    commit,
    npmDigest: values["npm-digest"] ?? process.env.SLIM_NPM_DIGEST ?? null,
    actionDigest: values["action-digest"] ?? process.env.SLIM_ACTION_DIGEST ?? null,
    workflowRun,
    fromDir: values.from,
    osNodeOnly,
    registryUrl: values.registry,
  });
  process.stdout.write(
    `qualify-candidate: mode=${mode} npm=${result.npmDigest ?? "-"} action=${result.actionDigest ?? "-"} written=${result.written.length}\n`,
  );
  throwIfUnqualified(result.failures);
  process.stdout.write(`qualify-candidate: ${mode} receipts current\n`);
} catch (err) {
  const code = err instanceof SlimExit ? err.code : 1;
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`qualify-candidate: ${msg}\n`);
  process.exit(code);
}
