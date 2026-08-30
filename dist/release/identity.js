/**
 * MIT License
 *
 * Release identity: version, tag, changelog, package, registry, workflow permissions.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_ENV, EXIT_REFUSED, SlimExit } from "../exit.js";
export const EXPECTED_PACKAGE_NAME = "slim";
export const EXPECTED_GITHUB_REPO = "GSXRcoder159/slim";
export const EXPECTED_REPOSITORY = `git+https://github.com/${EXPECTED_GITHUB_REPO}.git`;
export const EXPECTED_BUGS_URL = `https://github.com/${EXPECTED_GITHUB_REPO}/issues`;
export const EXPECTED_HOMEPAGE = `https://github.com/${EXPECTED_GITHUB_REPO}#readme`;
export const EXPECTED_REGISTRY = "https://registry.npmjs.org";
/** Consumer Action pin in docs/examples. 0.x releases still update this floating tag. */
export const ADVERTISED_ACTION_TAG = "v1";
export function advertisedActionUses(name) {
    return `${EXPECTED_GITHUB_REPO}/action/${name}@${ADVERTISED_ACTION_TAG}`;
}
export function versionTag(version) {
    return `v${version}`;
}
export function floatingTag(version) {
    const major = Number(version.split(".")[0]);
    if (!Number.isInteger(major) || major < 0) {
        throw new SlimExit(EXIT_REFUSED, `invalid version ${version}`);
    }
    if (major === 0)
        return ADVERTISED_ACTION_TAG;
    return `v${major}`;
}
export function packageVersion(root) {
    const pkg = readPackage(root);
    if (typeof pkg.version !== "string" || !pkg.version) {
        throw new SlimExit(EXIT_REFUSED, "package.json version is missing");
    }
    return pkg.version;
}
export function changelogVersion(root) {
    const text = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const m = text.match(/^##\s+(\S+)\s*$/m);
    if (!m?.[1]) {
        throw new SlimExit(EXIT_REFUSED, "CHANGELOG.md has no ## version heading");
    }
    return m[1];
}
export function assertVersionIdentity(opts) {
    const version = packageVersion(opts.root);
    const want = versionTag(version);
    if (opts.tag !== want) {
        throw new SlimExit(EXIT_REFUSED, `tag ${opts.tag} does not match package.json version ${version} (expected ${want})`);
    }
    const log = changelogVersion(opts.root);
    if (log !== version) {
        throw new SlimExit(EXIT_REFUSED, `changelog version ${log} does not match package.json version ${version}`);
    }
}
export function assertMigrationGuidance(root) {
    const version = packageVersion(root);
    const text = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const heading = `## ${version}`;
    const start = text.indexOf(heading);
    if (start < 0) {
        throw new SlimExit(EXIT_REFUSED, `CHANGELOG.md missing ## ${version} heading`);
    }
    const rest = text.slice(start + heading.length);
    const next = rest.search(/^##\s+/m);
    const section = next < 0 ? rest : rest.slice(0, next);
    if (!/###\s+Revert\s*\/\s*migration/i.test(section)) {
        throw new SlimExit(EXIT_REFUSED, `CHANGELOG.md ${version} missing Revert / migration guidance`);
    }
}
export function assertCleanTree(root) {
    let porcelain;
    try {
        porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    }
    catch (err) {
        throw new SlimExit(EXIT_REFUSED, `git status failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (porcelain.trim()) {
        throw new SlimExit(EXIT_REFUSED, `dirty or untracked tree:\n${porcelain}`);
    }
}
function readPackage(root) {
    try {
        return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    }
    catch {
        throw new SlimExit(EXIT_REFUSED, `cannot read ${join(root, "package.json")}`);
    }
}
export function assertPackageIdentity(root) {
    const pkg = readPackage(root);
    if (pkg.name !== EXPECTED_PACKAGE_NAME) {
        throw new SlimExit(EXIT_REFUSED, `package name ${String(pkg.name)} is not ${EXPECTED_PACKAGE_NAME}`);
    }
    const url = pkg.repository && typeof pkg.repository === "object" && "url" in pkg.repository
        ? pkg.repository.url
        : undefined;
    if (url !== EXPECTED_REPOSITORY) {
        throw new SlimExit(EXIT_REFUSED, `repository.url ${String(url)} is not ${EXPECTED_REPOSITORY}`);
    }
    const published = pkg.publishConfig && typeof pkg.publishConfig === "object" && "registry" in pkg.publishConfig
        ? pkg.publishConfig.registry
        : undefined;
    if (typeof published === "string")
        assertRegistry(published);
}
export function assertRegistry(registryUrl) {
    const normalized = registryUrl.replace(/\/+$/, "");
    if (normalized !== EXPECTED_REGISTRY) {
        throw new SlimExit(EXIT_REFUSED, `registry ${registryUrl} is not ${EXPECTED_REGISTRY}`);
    }
}
export function assertWorkflowPermissions(workflowYaml) {
    const block = workflowYaml.match(/^permissions:\s*\n((?:[ \t]+.+\n)*)/m);
    const body = block?.[1] ?? "";
    if (!/id-token:\s*write/.test(body)) {
        throw new SlimExit(EXIT_ENV, "release workflow missing permissions.id-token: write");
    }
    if (!/contents:\s*write/.test(body)) {
        throw new SlimExit(EXIT_ENV, "release workflow missing permissions.contents: write");
    }
}
export function readReleaseWorkflow(root) {
    return readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
}
//# sourceMappingURL=identity.js.map