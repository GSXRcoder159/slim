import { generateWithLlm } from "./llm.js";
import { assertValidGenerated } from "./validate.js";
import { checkContracts } from "./exports.js";
import { loadTargetTypescript } from "../project.js";
import { capCounterexamples } from "./prompt.js";
import { SlimExit, EXIT_FAIL } from "../exit.js";
export async function repairLoop(opts) {
    let source = opts.initial;
    let attempts = 0;
    let promptHash;
    const ts = loadTargetTypescript(opts.projectRoot);
    const examples = [];
    const generate = opts.generate ?? generateWithLlm;
    const maxAttempts = Math.max(1, opts.maxAttempts);
    const cannotRepair = () => opts.catalog || !opts.llm || attempts >= maxAttempts;
    const summarize = (report) => report.disagreements.map((d) => `${d.symbol}: ${d.reason} args=${JSON.stringify(d.minimized ?? d.args)}`);
    while (attempts < maxAttempts) {
        attempts++;
        assertValidGenerated(ts, source, opts.envelope);
        const contracts = checkContracts(ts, source, opts.envelope);
        if (!contracts.ok) {
            examples.push(...contracts.errors);
            if (cannotRepair()) {
                throw new SlimExit(EXIT_FAIL, `generated contracts failed: ${examples.join("; ")}`);
            }
            const next = await generate(opts.envelope, opts.publicApi, capCounterexamples(examples), opts.llm);
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
        const next = await generate(opts.envelope, opts.publicApi, capCounterexamples(examples), opts.llm);
        source = next.source;
        promptHash = next.promptHash;
    }
    throw new SlimExit(EXIT_FAIL, `repair exhausted: ${examples.join("; ")}`);
}
//# sourceMappingURL=repair.js.map