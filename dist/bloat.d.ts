/**
 * MIT License
 *
 * Fail when a production dependency is a known fat package without a Slim replacement.
 */
/** Production direct deps in BLOAT_PACKAGES that have no Slim replacement. Ignores devDependencies and import sites. */
export declare function runBloatCheck(cwd?: string): number;
