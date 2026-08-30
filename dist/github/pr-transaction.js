/**
 * MIT License
 *
 * Cross-check PR title, body, branch, files, and labels against the accepted
 * replacement (or upstream) transaction before any git mutation.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hashEnvelope } from "../envelope/types.js";
import { sha256File } from "../evidence/digests.js";
import { EXIT_FAIL, SlimExit } from "../exit.js";
import { fileBase } from "../rewrite/paths.js";
export const REPLACE_PR_LABELS = ["slim", "slim:replace"];
export const UPSTREAM_PR_LABELS = ["slim", "slim:upstream"];
export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const ARTIFACT_DIGEST_RE = /Candidate artifact digest:\s+`([0-9a-f]{64})`/i;
export { sha256Bytes, sha256File } from "../evidence/digests.js";
function posix(rel) {
    return rel.replace(/\\/g, "/");
}
function field(body, re, name) {
    const m = body.match(re);
    if (!m?.[1]) {
        throw new SlimExit(EXIT_FAIL, `PR body missing ${name}`);
    }
    return m[1];
}
function labelsEqual(got, want) {
    if (got.length !== want.length)
        return false;
    return got.every((l, i) => l === want[i]);
}
function sortedEqual(got, want) {
    const a = [...got].map(posix).sort();
    const b = [...want].map(posix).sort();
    return a.length === b.length && a.every((x, i) => x === b[i]);
}
function normalizeBody(s) {
    return s.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}
function inferPkg(opts) {
    if (opts.pkg)
        return opts.pkg;
    for (const f of opts.files) {
        const m = posix(f).match(/^\.slim\/(.+)\/evidence\.md$/);
        if (m?.[1])
            return m[1];
    }
    const titled = opts.title.match(/^slim: replace (.+) with a verified slice$/);
    if (titled?.[1])
        return titled[1];
    throw new SlimExit(EXIT_FAIL, "cannot infer package for pull request transaction");
}
function inferKind(opts) {
    if (opts.kind)
        return opts.kind;
    if (opts.branch === "slim/upstream" || opts.labels.includes("slim:upstream"))
        return "upstream";
    return "replace";
}
function isAllowedReplacePath(rel, pkg, moduleRel, rewrites) {
    const p = posix(rel);
    if (p.startsWith(".slim/"))
        return true;
    if (p === moduleRel || p.startsWith("src/slim/"))
        return true;
    if (p === "package.json" || p === "slim.json")
        return true;
    if (/^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(p))
        return true;
    if (rewrites.includes(p))
        return true;
    if (p === `src/slim/${fileBase(pkg)}.ts` || p === `src/slim/${fileBase(pkg)}.js`)
        return true;
    return false;
}
function loadJson(path, what) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        throw new SlimExit(EXIT_FAIL, `missing or malformed ${what}`);
    }
}
export function withArtifactDigest(body, digest) {
    if (!SHA256_HEX.test(digest)) {
        throw new SlimExit(EXIT_FAIL, "missing candidate artifact digest");
    }
    const m = body.match(ARTIFACT_DIGEST_RE);
    if (m) {
        if (m[1] !== digest) {
            throw new SlimExit(EXIT_FAIL, "PR candidate artifact digest does not match the accepted transaction");
        }
        return body;
    }
    return `${body.replace(/\s*$/, "")}\n\n- Candidate artifact digest: \`${digest}\`\n`;
}
export function assertEvidenceBodyMatchesDisk(root, pkg, body) {
    const evidenceJsonPath = join(root, ".slim", pkg, "evidence.json");
    const envelopePath = join(root, ".slim", pkg, "envelope.json");
    const evidence = loadJson(evidenceJsonPath, `.slim/${pkg}/evidence.json`);
    const envelope = loadJson(envelopePath, `.slim/${pkg}/envelope.json`);
    const envHash = hashEnvelope(envelope);
    if (evidence.envelopeHash !== envHash) {
        throw new SlimExit(EXIT_FAIL, "evidence.json envelope hash does not match envelope.json");
    }
    const moduleRel = posix(evidence.revert?.module ?? `src/slim/${fileBase(pkg)}.ts`);
    const modulePath = join(root, moduleRel);
    if (!existsSync(modulePath)) {
        throw new SlimExit(EXIT_FAIL, `missing replacement module ${moduleRel}`);
    }
    const evidenceHash = sha256File(evidenceJsonPath);
    const moduleDigest = sha256File(modulePath);
    const bodyPkg = field(body, /Package:\s+`([^`]+)`/, "package");
    const wantPkg = `${evidence.package.name}@${evidence.package.version}`;
    if (bodyPkg !== wantPkg) {
        throw new SlimExit(EXIT_FAIL, `PR package ${bodyPkg} does not match ${wantPkg}`);
    }
    const bodyEnv = field(body, /Envelope hash:\s+`([0-9a-f]+)`/i, "envelope hash");
    if (bodyEnv !== evidence.envelopeHash || bodyEnv !== envHash) {
        throw new SlimExit(EXIT_FAIL, "PR envelope hash does not match accepted evidence");
    }
    const bodyEvidence = field(body, /Evidence hash:\s+`([0-9a-f]+)`/i, "evidence hash");
    if (bodyEvidence !== evidenceHash) {
        throw new SlimExit(EXIT_FAIL, "PR evidence hash does not match evidence.json");
    }
    const bodyModule = field(body, /Module digest:\s+`([0-9a-f]+)`/i, "module digest");
    if (bodyModule !== moduleDigest) {
        throw new SlimExit(EXIT_FAIL, "PR module digest does not match the replacement file");
    }
    const bodySeed = field(body, /seed:\s+(\d+)/i, "fuzz seed");
    if (Number(bodySeed) !== evidence.fuzz.seed) {
        throw new SlimExit(EXIT_FAIL, "PR fuzz seed does not match evidence.json");
    }
    const bodyCases = field(body, /cases:\s+(\d+)/i, "fuzz cases");
    if (Number(bodyCases) !== evidence.fuzz.cases) {
        throw new SlimExit(EXIT_FAIL, "PR fuzz cases do not match evidence.json");
    }
    const bodyDisagree = field(body, /disagreements:\s+(\d+)/i, "fuzz disagreements");
    if (Number(bodyDisagree) !== evidence.fuzz.disagreements) {
        throw new SlimExit(EXIT_FAIL, "PR fuzz disagreements do not match evidence.json");
    }
    return moduleRel;
}
function assertBaseAndDigest(opts) {
    if (!opts.base?.trim()) {
        throw new SlimExit(EXIT_FAIL, "PR base must match the accepted transaction");
    }
    if (!opts.artifactDigest || !SHA256_HEX.test(opts.artifactDigest)) {
        throw new SlimExit(EXIT_FAIL, "missing candidate artifact digest");
    }
    const got = field(opts.body, ARTIFACT_DIGEST_RE, "candidate artifact digest");
    if (got !== opts.artifactDigest) {
        throw new SlimExit(EXIT_FAIL, "PR candidate artifact digest does not match the accepted transaction");
    }
}
function assertReplaceTransaction(opts) {
    const pkg = inferPkg(opts);
    const wantLabels = [...REPLACE_PR_LABELS];
    if (!labelsEqual(opts.labels, wantLabels)) {
        throw new SlimExit(EXIT_FAIL, `PR labels must be ${wantLabels.join(", ")}; got ${opts.labels.join(", ") || "(none)"}`);
    }
    const wantBranch = `slim/${fileBase(pkg)}`;
    if (opts.branch !== wantBranch) {
        throw new SlimExit(EXIT_FAIL, `PR branch ${opts.branch} does not match ${wantBranch}`);
    }
    if (opts.title !== `slim: replace ${pkg} with a verified slice`) {
        throw new SlimExit(EXIT_FAIL, `PR title does not name package ${pkg}`);
    }
    const moduleRel = assertEvidenceBodyMatchesDisk(opts.root, pkg, opts.body);
    const evidenceJsonPath = join(opts.root, ".slim", pkg, "evidence.json");
    const evidence = loadJson(evidenceJsonPath, `.slim/${pkg}/evidence.json`);
    const files = opts.files.map(posix);
    const required = [
        moduleRel,
        `.slim/${pkg}/evidence.md`,
        `.slim/${pkg}/evidence.json`,
        `.slim/${pkg}/envelope.json`,
    ];
    for (const req of required) {
        if (!files.includes(req)) {
            throw new SlimExit(EXIT_FAIL, `PR file list missing ${req}`);
        }
    }
    const rewrites = (evidence.revert?.rewrites ?? []).map((r) => posix(r.file));
    for (const f of files) {
        if (!isAllowedReplacePath(f, pkg, moduleRel, rewrites)) {
            throw new SlimExit(EXIT_FAIL, `refusing to commit unrelated path ${f}`);
        }
    }
}
function assertUpstreamTransaction(opts) {
    const wantLabels = [...UPSTREAM_PR_LABELS];
    if (!labelsEqual(opts.labels, wantLabels)) {
        throw new SlimExit(EXIT_FAIL, `PR labels must be ${wantLabels.join(", ")}; got ${opts.labels.join(", ") || "(none)"}`);
    }
    if (opts.branch !== "slim/upstream") {
        throw new SlimExit(EXIT_FAIL, `PR branch ${opts.branch} does not match slim/upstream`);
    }
    if (!/^slim: upstream slice fix for \S+$/.test(opts.title)) {
        throw new SlimExit(EXIT_FAIL, "PR title does not match slim: upstream slice fix for <id>");
    }
    const files = opts.files.map(posix);
    if (!files.includes(".slim/UPSTREAM.md")) {
        throw new SlimExit(EXIT_FAIL, "PR file list missing .slim/UPSTREAM.md");
    }
    if (!/EVIDENCE, NOT PROOF/i.test(opts.body)) {
        throw new SlimExit(EXIT_FAIL, "upstream PR body missing EVIDENCE, NOT PROOF");
    }
    const regenerated = /regenerated the replacement and fuzzed/i.test(opts.body);
    const unmapped = /could not be mapped/i.test(opts.body);
    if (unmapped && regenerated) {
        throw new SlimExit(EXIT_FAIL, "unmapped upstream PR cannot claim a successful rewrite");
    }
    if (!unmapped && !regenerated && !/no automatic fix|verification unavailable|may expose this repo/i.test(opts.body)) {
        throw new SlimExit(EXIT_FAIL, "upstream PR body is missing a fail-closed conclusion");
    }
    if (/Evidence hash:/i.test(opts.body)) {
        const pkgs = new Set();
        for (const f of files) {
            const m = f.match(/^\.slim\/(.+)\/evidence\.md$/);
            if (m?.[1])
                pkgs.add(m[1]);
        }
        if (!pkgs.size) {
            const m = opts.body.match(/Package:\s+`([^@`]+)/);
            if (m?.[1])
                pkgs.add(m[1]);
        }
        for (const pkg of pkgs) {
            assertEvidenceBodyMatchesDisk(opts.root, pkg, opts.body);
        }
    }
}
export function assertPrMatchesTransaction(opts) {
    if (!opts.labels?.length) {
        throw new SlimExit(EXIT_FAIL, "PR labels must match the accepted transaction");
    }
    assertBaseAndDigest(opts);
    const kind = inferKind(opts);
    if (kind === "upstream")
        assertUpstreamTransaction(opts);
    else
        assertReplaceTransaction(opts);
}
export function assertCommitMatchesTransaction(gitOut, sha, files, title, head) {
    const parent = gitOut(["rev-parse", `${sha}^`]).trim();
    if (parent !== head) {
        throw new SlimExit(EXIT_FAIL, `Slim commit parent ${parent} is not HEAD ${head}`);
    }
    const message = gitOut(["log", "-1", "--format=%s", sha]).trim();
    if (message !== title) {
        throw new SlimExit(EXIT_FAIL, `Slim commit message does not match PR title`);
    }
    const names = gitOut(["diff-tree", "--no-commit-id", "--name-only", "-r", sha])
        .split("\n")
        .map((s) => posix(s.trim()))
        .filter(Boolean)
        .sort();
    const expected = [...files].map(posix).sort();
    if (names.length !== expected.length || names.some((n, i) => n !== expected[i])) {
        throw new SlimExit(EXIT_FAIL, `Slim commit files [${names.join(", ")}] do not match [${expected.join(", ")}]`);
    }
}
export function assertRemotePrMatchesTransaction(remote, accepted) {
    if (remote.title !== accepted.title) {
        throw new SlimExit(EXIT_FAIL, "remote PR title does not match the accepted transaction");
    }
    if (normalizeBody(remote.body) !== normalizeBody(accepted.body)) {
        throw new SlimExit(EXIT_FAIL, "remote PR body does not match the accepted transaction");
    }
    if (remote.base !== accepted.base) {
        throw new SlimExit(EXIT_FAIL, `remote PR base ${remote.base} does not match ${accepted.base}`);
    }
    if (remote.head !== accepted.branch) {
        throw new SlimExit(EXIT_FAIL, `remote PR head ${remote.head} does not match ${accepted.branch}`);
    }
    if (remote.headSha !== accepted.sha) {
        throw new SlimExit(EXIT_FAIL, `remote PR head SHA does not match the Slim commit`);
    }
    if (!sortedEqual(remote.labels, [...accepted.labels])) {
        throw new SlimExit(EXIT_FAIL, `remote PR labels [${remote.labels.join(", ")}] do not match [${accepted.labels.join(", ")}]`);
    }
    if (!sortedEqual(remote.files, accepted.files)) {
        throw new SlimExit(EXIT_FAIL, `remote PR files [${remote.files.map(posix).join(", ")}] do not match [${accepted.files.map(posix).join(", ")}]`);
    }
}
export function parsePullRequestNumber(url) {
    const m = url.trim().match(/\/pull\/(\d+)/);
    if (!m?.[1]) {
        throw new SlimExit(EXIT_FAIL, `cannot parse pull request number from ${url}`);
    }
    return Number(m[1]);
}
//# sourceMappingURL=pr-transaction.js.map