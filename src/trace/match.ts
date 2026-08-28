export function matchesTracedUrl(url: string, packages: string[]): boolean {
  let pathname = url.replace(/\\/g, "/");
  try {
    pathname = decodeURIComponent(new URL(url).pathname).replace(/\\/g, "/");
  } catch {
    /* keep raw */
  }
  const sorted = [...packages].sort((a, b) => b.length - a.length);
  for (const pkg of sorted) {
    const needle = `/node_modules/${pkg}`;
    const idx = pathname.indexOf(needle);
    if (idx === -1) continue;
    const after = pathname.slice(idx + needle.length);
    if (after === "" || after.startsWith(".")) return true;
    if (!after.startsWith("/")) continue;
    const first = after.slice(1).split("/")[0] ?? "";
    if (first === "node_modules") continue;
    return true;
  }
  return false;
}

export function packageFromUrl(url: string, packages: string[]): string | null {
  const sorted = [...packages].sort((a, b) => b.length - a.length);
  for (const pkg of sorted) {
    if (matchesTracedUrl(url, [pkg])) return pkg;
  }
  return null;
}
