import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashEnvelope } from "../envelope/hash.js";
import { gzipGuess } from "../size/estimate.js";
import { maybeBundleBytes } from "../size/bundle.js";
import { formatRevert } from "../rewrite/revert.js";
import { assertDocument } from "../schema/documents.js";
import { artifactDigests, sha256Bytes } from "./digests.js";
const EXAMPLE_CAP = 500;
export const EVIDENCE_SCHEMA_VERSION = 1;
export function writeEvidence(opts) {
    const dir = opts.dir ?? join(opts.root, ".slim", opts.env.package.name);
    mkdirSync(dir, { recursive: true });
    const hash = hashEnvelope(opts.env);
    const callSites = opts.env.symbols.reduce((n, s) => n + s.callSites.length, 0);
    const residual = residualRisk(opts.env, opts.fuzz);
    const bundle = opts.bundle === undefined ? maybeBundleBytes(opts.root) : opts.bundle;
    const generation = completeGeneration(opts.catalogIds, opts.generation);
    const artifacts = artifactDigests({
        root: opts.root,
        pkg: opts.env.package.name,
        outDir: dirname(opts.revert.module).replace(/\\/g, "/") || ".",
        moduleRel: opts.revert.module,
        oracleVersion: opts.env.package.version,
        moduleSource: opts.moduleSource,
    });
    const json = {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        slogan: "EVIDENCE, NOT PROOF",
        package: opts.env.package,
        envelopeHash: hash,
        symbols: opts.env.symbols.map((s) => s.exportName),
        callSites,
        unknowns: opts.env.unknowns.length,
        byteDelta: {
            originalMin: opts.originalMin,
            replacement: opts.replacementBytes,
            gzipOriginal: opts.originalMin != null ? gzipGuess(opts.originalMin) : null,
            ...(bundle ? { bundle } : {}),
        },
        fuzz: opts.fuzz,
        coverageHoles: opts.coverageHoles,
        residualRisk: residual,
        revert: opts.revert,
        generation,
        artifacts,
    };
    assertDocument("evidence", json);
    const jsonPath = join(dir, "evidence.json");
    const mdPath = join(dir, "evidence.md");
    writeFileSync(jsonPath, JSON.stringify(json, null, 2) + "\n");
    const evidenceHash = sha256Bytes(readFileSync(jsonPath));
    const md = renderEvidenceMd(json, opts.env, opts.catalogIds, { evidenceHash });
    writeFileSync(mdPath, md);
    return { mdPath, jsonPath, residualRisk: residual };
}
function completeGeneration(catalogIds, partial) {
    const kind = partial?.kind ?? (catalogIds.length ? "catalog" : "llm");
    const counterexamples = (partial?.counterexamples ?? []).map((s) => s.length > EXAMPLE_CAP ? `${s.slice(0, EXAMPLE_CAP)}…` : s);
    return {
        kind,
        catalogIds: partial?.catalogIds ?? catalogIds,
        attempts: partial?.attempts ?? 1,
        specSource: partial?.specSource ?? (kind === "catalog" ? "catalog" : "envelope-only"),
        counterexamples,
        ...(partial?.provider ? { provider: partial.provider } : {}),
        ...(partial?.model ? { model: partial.model } : {}),
        ...(partial?.promptHash ? { promptHash: partial.promptHash } : {}),
        ...(partial?.limitation ? { limitation: partial.limitation } : {}),
    };
}
export function renderEvidenceMd(json, env, catalogIds = [], digests = {}) {
    const orig = json.byteDelta.originalMin;
    const delta = orig != null
        ? `${orig} B estimated original min → ${json.byteDelta.replacement} B replacement`
        : `${json.byteDelta.replacement} B replacement (original size unknown)`;
    const bundleLine = json.byteDelta.bundle
        ? `\n- ${json.byteDelta.bundle.tool} dry-run of \`${json.byteDelta.bundle.entry}\`: ${json.byteDelta.bundle.bytes} B`
        : "";
    const edge = env.package.family === "lodash"
        ? [
            "Stock lodash uses `Function(String)` and is rejected on Cloudflare/Vercel Edge. This slice does not.",
            "Cloudflare isolate CPU is a vendor startup budget. Slim does not publish a measured Worker cold-start number.",
        ].join("\n")
        : "n/a";
    return `# EVIDENCE, NOT PROOF

Differential fuzzing over the inferred envelope is **strong evidence, not proof**. Slim ships the envelope as a standing regression suite. When a new call site appears, \`slim check\` fails and you re-run \`slim replace\`.

## 1. Evidence, not proof

Differential fuzzing over the inferred envelope is strong evidence, not proof.

## 2. What was used

- Package: \`${json.package.name}@${json.package.version}\` (family \`${json.package.family}\`)
- Symbols: ${json.symbols.map((s) => "`" + s + "`").join(", ") || "(none)"}
- Call sites: ${json.callSites}
- Unknowns: ${json.unknowns}
- Catalog: ${catalogIds.join(", ") || json.generation?.catalogIds.join(", ") || "LLM"}
- Envelope hash: \`${json.envelopeHash}\`${digestMd(json, digests)}${generationMd(json)}

## 3. Byte delta

${delta}${bundleLine}

## 4. Edge

${edge}

## 5. Fuzz

- cases: ${json.fuzz.cases}
- comparisons: ${json.fuzz.comparisons}
- timerCases: ${json.fuzz.timerCases}
- traces replayed: ${json.fuzz.tracesReplayed}
- disagreements: ${json.fuzz.disagreements}
- wall: ${json.fuzz.wallMs} ms
- seed: ${json.fuzz.seed}${json.fuzz.allowFlaky ? "\n- allow-flaky: yes (not production-ready)" : ""}

## 6. Coverage holes

${json.coverageHoles.length ? json.coverageHoles.map((h) => `- ${h}`).join("\n") : "- (none recorded)"}

## 7. Upstream pin

Slim will watch this slice via \`slim upstream\` / osv.dev. Registry: https://www.npmjs.com/package/${json.package.name}

## 8. How to revert

${formatRevert(json.revert)}

## Residual risk

${json.residualRisk.map((x) => `- ${x}`).join("\n")}
`;
}
function digestMd(json, digests) {
    const lines = [];
    if (digests.evidenceHash)
        lines.push(`- Evidence hash: \`${digests.evidenceHash}\``);
    const a = json.artifacts;
    if (a) {
        lines.push(`- Module digest: \`${a.moduleDigest}\``);
        lines.push(`- Standing digest: \`${a.standingDigest}\``);
        lines.push(`- Hardening digest: \`${a.hardeningDigest}\``);
        lines.push(`- Oracle version: \`${a.oracleVersion}\``);
        lines.push(`- Fixture revision: \`${a.fixtureRevision}\``);
    }
    return lines.length ? `\n${lines.join("\n")}` : "";
}
function generationMd(json) {
    const g = json.generation;
    if (!g || g.kind !== "llm")
        return "";
    const lines = [
        "",
        `- Generation: LLM (${g.provider ?? "unknown"} / ${g.model ?? "unknown"})`,
        `- Prompt hash: \`${g.promptHash ?? "none"}\``,
        `- Attempts: ${g.attempts}`,
        `- Spec source: ${g.specSource}`,
    ];
    if (g.limitation)
        lines.push(`- Spec limitation: ${g.limitation}`);
    if (g.counterexamples.length) {
        lines.push("- Repair counterexamples:");
        for (const ex of g.counterexamples)
            lines.push(`  - ${ex}`);
    }
    return lines.join("\n");
}
function residualRisk(env, fuzz) {
    const r = [
        "Differential fuzzing over the inferred envelope is strong evidence, not proof. Unobserved call shapes can still disagree.",
    ];
    if (!fuzz.tracesReplayed || env.traces.length === 0) {
        r.push("No runtime traces. Generators are static-shape plus catalog mutations, not your runtime distribution.");
    }
    if (env.closure.reason.includes("--no-trace")) {
        r.push("--no-trace: static-only evidence; runtime distribution was not observed and cannot claim trace closure.");
    }
    if (env.closure.confidence === "trace-closed" && env.traces.length === 0) {
        r.push("Static-only evidence cannot claim trace closure.");
    }
    if (env.unknowns.length) {
        r.push(`Unknown sites remain: ${env.unknowns.map((u) => u.kind).join(", ")}.`);
    }
    if (env.clock) {
        r.push("Timer taxonomy is sampled, not exhaustive of every interleaving.");
    }
    if (fuzz.allowFlaky) {
        r.push("--allow-flaky: fuzz is not production-ready evidence.");
    }
    else if (env.cryptoRandom) {
        r.push("RNG is isolated with injectable crypto in fuzz; production uses platform CSPRNG.");
    }
    r.push("Upstream may patch bugs outside this slice; slim upstream watches advisories for used symbols.");
    return r;
}
//# sourceMappingURL=report.js.map