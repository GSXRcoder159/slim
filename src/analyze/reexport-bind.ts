import type { Binding, CollectExtra, LocalPending, PkgLink } from "./model.ts";
import { parseSpecifier } from "./family.ts";
import { specifierMatches } from "./reexports.ts";
import { normPath, resolveRelative } from "./model.ts";

export const MAX_REEXPORT_HOPS = 32;

export function bindLocalReexports(bindings: Binding[], extra: CollectExtra): void {
  for (const pending of extra.localPending) {
    const before = bindings.length;
    const flags = { cycle: false, unresolved: false, depth: false, wantedOnWalk: false };
    applyPkgLinks(pending, pending.resolvedFile, extra, bindings, 0, new Set(), flags);
    const added = bindings.slice(before);
    if (pendingBound(pending, added)) continue;
    if (!flags.cycle && !flags.unresolved && !flags.depth) continue;
    if (!flags.wantedOnWalk && !pendingTouchesWantedPkg(pending, extra)) continue;
    const why = [
      flags.cycle ? "cyclic local re-export chain" : "",
      flags.unresolved ? "unresolved re-export terminal" : "",
      flags.depth ? `re-export depth exceeds ${MAX_REEXPORT_HOPS}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    extra.unknowns.push({
      id: `reexport:${pending.loc.file}:${pending.loc.line}:${pending.loc.column}`,
      loc: pending.loc,
      kind: "unresolved-reexport",
      detail: why,
      widensTo: "refuse",
      traceObservedMembers: null,
    });
  }
}

function pendingRequested(pending: LocalPending): string[] {
  const names = pending.names.map((n) => n.imported);
  if (pending.namespaceLocal) names.push("*");
  if (pending.defaultLocal) names.push("default");
  return names;
}

function pendingBound(pending: LocalPending, added: Binding[]): boolean {
  const req = pendingRequested(pending);
  if (!req.length) return true;
  return req.some((n) => added.some((b) => b.imported === n));
}

function pendingTouchesWantedPkg(pending: LocalPending, extra: CollectExtra): boolean {
  const req = new Set(pendingRequested(pending));
  for (const link of extra.pkgLinks) {
    if (!parseSpecifier(link.specifier)) continue;
    if (extra.wanted && !specifierMatches(link.specifier, extra.wanted)) continue;
    if (link.names === "*") return req.size > 0;
    for (const n of req) {
      if (link.names.has(n)) return true;
      for (const orig of link.names.values()) if (orig === n) return true;
    }
  }
  return false;
}

function applyPkgLinks(
  pending: LocalPending,
  file: string,
  extra: CollectExtra,
  bindings: Binding[],
  hop: number,
  visited: Set<string>,
  flags: { cycle: boolean; unresolved: boolean; depth: boolean; wantedOnWalk: boolean },
): void {
  if (hop > MAX_REEXPORT_HOPS) {
    flags.depth = true;
    return;
  }
  const nf = normPath(file);
  if (visited.has(nf)) {
    flags.cycle = true;
    return;
  }
  visited.add(nf);
  for (const link of extra.pkgLinks) {
    if (normPath(link.file) !== nf) continue;
    if (parseSpecifier(link.specifier) && (!extra.wanted || specifierMatches(link.specifier, extra.wanted))) {
      flags.wantedOnWalk = true;
    }
    addBindingsFromLink(pending, link, bindings);
  }
  for (const hopSpec of extra.localHops) {
    if (normPath(hopSpec.file) !== nf) continue;
    const next = resolveRelative(hopSpec.file, hopSpec.specifier);
    if (!next) {
      flags.unresolved = true;
      continue;
    }
    applyPkgLinks(pending, next, extra, bindings, hop + 1, visited, flags);
  }
}

function addBindingsFromLink(pending: LocalPending, link: PkgLink, bindings: Binding[]): void {
  if (link.names === "*") {
    if (pending.namespaceLocal) {
      bindings.push({
        local: pending.namespaceLocal,
        imported: "*",
        specifier: link.specifier,
        kind: "namespace",
        loc: pending.loc,
      });
    }
    if (pending.defaultLocal) {
      bindings.push({
        local: pending.defaultLocal,
        imported: "default",
        specifier: link.specifier,
        kind: "default",
        loc: pending.loc,
      });
    }
    for (const n of pending.names) {
      if (n.imported === "default") continue;
      bindings.push({
        local: n.local,
        imported: n.imported,
        specifier: link.specifier,
        kind: "named",
        loc: pending.loc,
      });
    }
    return;
  }
  for (const n of pending.names) {
    const orig = link.names.get(n.imported);
    if (!orig) continue;
    bindings.push({
      local: n.local,
      imported: orig,
      specifier: link.specifier,
      kind: "named",
      loc: pending.loc,
    });
  }
}
