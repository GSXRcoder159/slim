import type { Envelope } from "../envelope/types.ts";
import { generateWithLlm, type LlmConfig } from "./llm.ts";
import type { PublicApiSpec } from "./public-api.ts";
export interface RepairFuzzReport {
    disagreements: Array<{
        symbol: string;
        args: unknown[];
        reason: string;
        minimized?: unknown[];
    }>;
}
export declare function repairLoop(opts: {
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
}>;
