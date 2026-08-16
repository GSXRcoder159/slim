import { readFileSync, writeFileSync } from "node:fs";

/** Line-oriented removal of a dependency key; preserves indent and sibling keys. */
export function removeDependencyKey(
  packageJsonText: string,
  depName: string,
): { text: string; removed: boolean } {
  const key = JSON.stringify(depName);
  const lines = packageJsonText.split(/\r?\n/);
  const out: string[] = [];
  let removed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.startsWith(key + ":") || trimmed.startsWith(key + " :")) {
      removed = true;
      const prev = out[out.length - 1];
      const next = lines[i + 1];
      if (next && /^\s*[}\]]/.test(next) && prev && prev.trimEnd().endsWith(",")) {
        out[out.length - 1] = prev.replace(/,\s*$/, "");
      }
      continue;
    }
    out.push(line);
  }
  return { text: out.join("\n"), removed };
}

export function rewritePackageJson(path: string, depName: string): boolean {
  const text = readFileSync(path, "utf8");
  const next = removeDependencyKey(text, depName);
  if (!next.removed) return false;
  writeFileSync(path, next.text);
  return true;
}
