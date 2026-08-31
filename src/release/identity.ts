/**
 * MIT License
 *
 * Release identity: version, tag, changelog, package, registry, workflow permissions.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_ENV, EXIT_REFUSED, SlimExit } from "../exit.ts";

export const EXPECTED_PACKAGE_NAME = "@gsxrcoder159/slim";
export const EXPECTED_GITHUB_REPO = "GSXRcoder159/slim";
export const EXPECTED_REPOSITORY = `git+https://github.com/${EXPECTED_GITHUB_REPO}.git`;
export const EXPECTED_BUGS_URL = `https://github.com/${EXPECTED_GITHUB_REPO}/issues`;
export const EXPECTED_HOMEPAGE = `https://github.com/${EXPECTED_GITHUB_REPO}#readme`;
export const EXPECTED_REGISTRY = "https://registry.npmjs.org";
export const EXPECTED_DEFAULT_BRANCH = "main";
export const EXPECTED_UNPKG_PREFIX = `https://unpkg.com/${EXPECTED_PACKAGE_NAME}/`;
/** Consumer Action pin in docs/examples. 0.x releases still update this floating tag. */
export const ADVERTISED_ACTION_TAG = "v1";

/** npm import of this package (`@gsxrcoder159/slim` or a subpath). */
export function packageImport(subpath?: "hooks" | "vitest"): string {
  return subpath ? `${EXPECTED_PACKAGE_NAME}/${subpath}` : EXPECTED_PACKAGE_NAME;
}

/** Host `node_modules` directory for this package after `npm install`. */
export function packageNodeModulesDir(root: string): string {
  return join(root, "node_modules", ...EXPECTED_PACKAGE_NAME.split("/"));
}

export function advertisedActionUses(name: "check" | "bloat" | "upstream"): string {
  return `${EXPECTED_GITHUB_REPO}/action/${name}@${ADVERTISED_ACTION_TAG}`;
}

export function versionTag(version: string): string {
  return `v${version}`;
}

export function floatingTag(version: string): string {
  const major = Number(version.split(".")[0]);
  if (!Number.isInteger(major) || major < 0) {
    throw new SlimExit(EXIT_REFUSED, `invalid version ${version}`);
  }
  if (major === 0) return ADVERTISED_ACTION_TAG;
  return `v${major}`;
}

export function packageVersion(root: string): string {
  const pkg = readPackage(root);
  if (typeof pkg.version !== "string" || !pkg.version) {
    throw new SlimExit(EXIT_REFUSED, "package.json version is missing");
  }
  return pkg.version;
}

export function changelogVersion(root: string): string {
  const text = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const m = text.match(/^##\s+(\S+)\s*$/m);
  if (!m?.[1]) {
    throw new SlimExit(EXIT_REFUSED, "CHANGELOG.md has no ## version heading");
  }
  return m[1];
}

export function assertVersionIdentity(opts: { root: string; tag: string }): void {
  const version = packageVersion(opts.root);
  const want = versionTag(version);
  if (opts.tag !== want) {
    throw new SlimExit(
      EXIT_REFUSED,
      `tag ${opts.tag} does not match package.json version ${version} (expected ${want})`,
    );
  }
  const log = changelogVersion(opts.root);
  if (log !== version) {
    throw new SlimExit(
      EXIT_REFUSED,
      `changelog version ${log} does not match package.json version ${version}`,
    );
  }
}

export function assertMigrationGuidance(root: string): void {
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
    throw new SlimExit(
      EXIT_REFUSED,
      `CHANGELOG.md ${version} missing Revert / migration guidance`,
    );
  }
}

export function assertCleanTree(root: string): void {
  let porcelain: string;
  try {
    porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  } catch (err) {
    throw new SlimExit(EXIT_REFUSED, `git status failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (porcelain.trim()) {
    throw new SlimExit(EXIT_REFUSED, `dirty or untracked tree:\n${porcelain}`);
  }
}

type Pkg = {
  name?: unknown;
  version?: unknown;
  repository?: { url?: unknown } | unknown;
  bugs?: { url?: unknown } | unknown;
  homepage?: unknown;
  publishConfig?: { registry?: unknown; access?: unknown };
};

function readPackage(root: string): Pkg {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Pkg;
  } catch {
    throw new SlimExit(EXIT_REFUSED, `cannot read ${join(root, "package.json")}`);
  }
}

export function assertPackageIdentity(root: string): void {
  const pkg = readPackage(root);
  if (pkg.name !== EXPECTED_PACKAGE_NAME) {
    throw new SlimExit(EXIT_REFUSED, `package name ${String(pkg.name)} is not ${EXPECTED_PACKAGE_NAME}`);
  }
  const url =
    pkg.repository && typeof pkg.repository === "object" && "url" in pkg.repository
      ? (pkg.repository as { url?: unknown }).url
      : undefined;
  if (url !== EXPECTED_REPOSITORY) {
    throw new SlimExit(EXIT_REFUSED, `repository.url ${String(url)} is not ${EXPECTED_REPOSITORY}`);
  }
  const bugs =
    pkg.bugs && typeof pkg.bugs === "object" && "url" in pkg.bugs
      ? (pkg.bugs as { url?: unknown }).url
      : undefined;
  if (bugs !== EXPECTED_BUGS_URL) {
    throw new SlimExit(EXIT_REFUSED, `bugs.url ${String(bugs)} is not ${EXPECTED_BUGS_URL}`);
  }
  if (pkg.homepage !== EXPECTED_HOMEPAGE) {
    throw new SlimExit(EXIT_REFUSED, `homepage ${String(pkg.homepage)} is not ${EXPECTED_HOMEPAGE}`);
  }
  const published =
    pkg.publishConfig && typeof pkg.publishConfig === "object" && "registry" in pkg.publishConfig
      ? (pkg.publishConfig as { registry?: unknown }).registry
      : undefined;
  if (published === undefined) {
    throw new SlimExit(EXIT_REFUSED, "package.json publishConfig.registry is missing");
  }
  assertRegistry(String(published));
  if (pkg.publishConfig?.access !== "public") {
    throw new SlimExit(EXIT_REFUSED, "package.json publishConfig.access must be public");
  }
}

export function assertPublishRef(opts: {
  mode: "identity" | "artifacts" | "rehearse" | "publish";
  tag: string;
  eventName?: string;
  ref?: string;
}): void {
  if (opts.mode !== "publish") return;
  const event = opts.eventName ?? process.env.GITHUB_EVENT_NAME ?? "";
  const ref = opts.ref ?? process.env.GITHUB_REF ?? "";
  if (event === "workflow_dispatch") {
    if (ref !== `refs/heads/${EXPECTED_DEFAULT_BRANCH}`) {
      throw new SlimExit(
        EXIT_REFUSED,
        `workflow_dispatch publish is only allowed from ${EXPECTED_DEFAULT_BRANCH} (got ${ref || "empty ref"})`,
      );
    }
    return;
  }
  if (event === "push" || ref.startsWith("refs/tags/")) {
    const want = `refs/tags/${opts.tag}`;
    if (ref !== want) {
      throw new SlimExit(EXIT_REFUSED, `publish tag ${ref || "empty ref"} does not match ${want}`);
    }
    return;
  }
  if (process.env.GITHUB_ACTIONS === "1") {
    throw new SlimExit(
      EXIT_REFUSED,
      `publish is not allowed from ${ref || "unknown ref"} (event ${event || "unknown"})`,
    );
  }
}

export function assertRegistry(registryUrl: string): void {
  const normalized = registryUrl.replace(/\/+$/, "");
  if (normalized !== EXPECTED_REGISTRY) {
    throw new SlimExit(EXIT_REFUSED, `registry ${registryUrl} is not ${EXPECTED_REGISTRY}`);
  }
}

export function assertWorkflowPermissions(workflowYaml: string): void {
  const block = workflowYaml.match(/^permissions:\s*\n((?:[ \t]+.+\n)*)/m);
  const body = block?.[1] ?? "";
  if (!/id-token:\s*write/.test(body)) {
    throw new SlimExit(EXIT_ENV, "release workflow missing permissions.id-token: write");
  }
  if (!/contents:\s*write/.test(body)) {
    throw new SlimExit(EXIT_ENV, "release workflow missing permissions.contents: write");
  }
}

export function readReleaseWorkflow(root: string): string {
  return readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
}
