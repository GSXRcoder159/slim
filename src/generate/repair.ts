import type { Envelope } from "../envelope/types.ts";
import { generateWithLlm, type LlmConfig } from "./llm.ts";
import { assertValidGenerated } from "./validate.ts";
import { loadTargetTypescript } from "../project.ts";

export interface RepairFuzzReport {
  disagreements: Array<{
    symbol: string;
    args: unknown[];
    reason: string;
    minimized?: unknown[];
  }>;
}

export async function repairLoop(opts: {
  envelope: Envelope;
  publicApi: string;
  initial: string;
  maxAttempts: number;
  llm: LlmConfig | null;
  projectRoot: string;
  fuzz: (source: string) => Promise<RepairFuzzReport>;
  catalog: boolean;
  generate?: typeof generateWithLlm;
}): Promise<{ source: string; report: RepairFuzzReport; attempts: number }> {
  let source = opts.initial;
  let attempts = 0;
  const ts = loadTargetTypescript(opts.projectRoot);
  const examples: string[] = [];
  const generate = opts.generate ?? generateWithLlm;
  while (attempts < Math.max(1, opts.maxAttempts)) {
    attempts++;
    assertValidGenerated(ts, source, opts.envelope);
    const report = await opts.fuzz(source);
    if (report.disagreements.length === 0) {
      return { source, report, attempts };
    }
    if (opts.catalog) {
      return { source, report, attempts };
    }
    if (!opts.llm || attempts >= opts.maxAttempts) {
      return { source, report, attempts };
    }
    examples.push(
      ...report.disagreements.map(
        (d) => `${d.symbol}: ${d.reason} args=${JSON.stringify(d.minimized ?? d.args)}`,
      ),
    );
    const next = await generate(opts.envelope, opts.publicApi, examples, opts.llm);
    source = next.source;
  }
  const report = await opts.fuzz(source);
  return { source, report, attempts };
}