/**
 * MIT License
 *
 * Release identity: version, tag, changelog, package, registry, workflow permissions.
 */
export declare const EXPECTED_PACKAGE_NAME = "slim";
export declare const EXPECTED_GITHUB_REPO = "GSXRcoder159/slim";
export declare const EXPECTED_REPOSITORY = "git+https://github.com/GSXRcoder159/slim.git";
export declare const EXPECTED_BUGS_URL = "https://github.com/GSXRcoder159/slim/issues";
export declare const EXPECTED_HOMEPAGE = "https://github.com/GSXRcoder159/slim#readme";
export declare const EXPECTED_REGISTRY = "https://registry.npmjs.org";
/** Consumer Action pin in docs/examples. 0.x releases still update this floating tag. */
export declare const ADVERTISED_ACTION_TAG = "v1";
export declare function advertisedActionUses(name: "check" | "bloat" | "upstream"): string;
export declare function versionTag(version: string): string;
export declare function floatingTag(version: string): string;
export declare function packageVersion(root: string): string;
export declare function changelogVersion(root: string): string;
export declare function assertVersionIdentity(opts: {
    root: string;
    tag: string;
}): void;
export declare function assertMigrationGuidance(root: string): void;
export declare function assertCleanTree(root: string): void;
export declare function assertPackageIdentity(root: string): void;
export declare function assertRegistry(registryUrl: string): void;
export declare function assertWorkflowPermissions(workflowYaml: string): void;
export declare function readReleaseWorkflow(root: string): string;
