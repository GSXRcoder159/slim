/** Single source of truth for the minimum supported Node version. */
export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 18;
export const MIN_NODE_LABEL = "22.18";
export const MIN_NODE_ENGINES = ">=22.18.0";

export function nodeMeetsMinimum(version = process.versions.node): boolean {
  const parts = version.split(".").map((n) => Number(n));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  return major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
}
