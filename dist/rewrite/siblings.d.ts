import type { Envelope } from "../envelope/types.ts";
/** Specifiers to rewrite: observed import sites plus the package being replaced. */
export declare function rewriteSpecifiers(env: Envelope, pkg: string): Set<string>;
/**
 * package.json keys to remove: the replaced package, plus family siblings that
 * have at least one import site in this envelope (those sites are rewritten).
 */
export declare function removeDependencyNames(env: Envelope, declared: Iterable<string>): Set<string>;
