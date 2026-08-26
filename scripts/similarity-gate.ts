#!/usr/bin/env node
import { runSimilarityGate } from "./similarity.ts";

const r = runSimilarityGate();
if (!r.ok) {
  console.error(r.failed);
  process.exit(1);
}
console.log(
  `similarity-gate ok (worst ${r.worst} hits in ${r.worstFile || "none"}; skipped oracle dirs: ${r.skipped.join(", ") || "none"})`,
);
