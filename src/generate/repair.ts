import type { Envelope } from "../envelope/types.ts";
import { generateWithLlm, type LlmConfig } from "./llm.ts";
import { assertValidGenerated } from "./validate.ts";
import { checkContracts } from "./exports.ts";
import { loadTargetTypescript } from "../project.ts";
import type { PublicApiSpec } from "./public-api.ts";
import { SlimExit, EXIT_FAIL } from "../exit.ts";

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
  publicApi: PublicApiSpec;
  initial: string;
  maxAttempts: number;
  llm: LlmConfig | null;
  projectRoot: string;
  fuzz: (source: string) => Promise<RepairFuzzReport>;
  catalog: boolean;
  generate?: typeof generateWithLlm;
}): Promise<{
  source: string;
  report: RepairFuzzReport;
  attempts: number;
  examples: string[];
  promptHash?: string;
}> {
  let source = opts.initial;
  let attempts = 0;
  let promptHash: string | undefined;
  const ts = loadTargetTypescript(opts.projectRoot);
  const examples: string[] = [];
  const generate = opts.generate ?? generateWithLlm;
  const maxAttempts = Math.max(1, opts.maxAttempts);

  const cannotRepair = () => opts.catalog || !opts.llm || attempts >= maxAttempts;

  const summarize = (report: RepairFuzzReport) =>
    report.disagreements.map(
      (d) => `${d.symbol}: ${d.reason} args=${JSON.stringify(d.minimized ?? d.args)}`,
    );

  while (attempts < maxAttempts) {
    attempts++;
    assertValidGenerated(ts, source, opts.envelope);
    const contracts = checkContracts(ts, source, opts.envelope);
    if (!contracts.ok) {
      examples.push(...contracts.errors);
      if (cannotRepair()) {
        throw new SlimExit(EXIT_FAIL, `generated contracts failed: ${examples.join("; ")}`);
      }
      const next = await generate(opts.envelope, opts.publicApi, examples, opts.llm!);
      source = next.source;
      promptHash = next.promptHash;
      continue;
    }
    const report = await opts.fuzz(source);
    if (report.disagreements.length === 0) {
      return { source, report, attempts, examples, promptHash };
    }
    if (opts.catalog) {
      return { source, report, attempts, examples, promptHash };
    }
    examples.push(...summarize(report));
    if (cannotRepair()) {
      throw new SlimExit(EXIT_FAIL, `fuzz disagreements remain: ${examples.join("; ")}`);
    }
    const next = await generate(opts.envelope, opts.publicApi, examples, opts.llm!);
    source = next.source;
    promptHash = next.promptHash;
  }

  throw new SlimExit(EXIT_FAIL, `repair exhausted: ${examples.join("; ")}`);
}
