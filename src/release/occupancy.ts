/**
 * MIT License
 *
 * Refuse occupied or unauthorized npm name/version before a release is releasable.
 */

import { execFileSync } from "node:child_process";
import { EXIT_ENV, EXIT_FAIL, EXIT_REFUSED, SlimExit } from "../exit.ts";
import { EXPECTED_PACKAGE_NAME, EXPECTED_REGISTRY, assertRegistry } from "./identity.ts";

export type OccupancyFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<Pick<Response, "status" | "json" | "ok">>;

export function packumentUrl(name: string, registryUrl = EXPECTED_REGISTRY): string {
  const base = registryUrl.replace(/\/+$/, "");
  return `${base}/${name.replaceAll("/", "%2f")}`;
}

function defaultWhoami(): string {
  try {
    return execFileSync("npm", ["whoami"], { encoding: "utf8" }).trim();
  } catch (err) {
    throw new SlimExit(
      EXIT_ENV,
      `npm whoami failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function assertNpmOccupancy(opts: {
  name?: string;
  version: string;
  registryUrl?: string;
  fetch?: OccupancyFetch;
  token?: string | null;
  whoami?: () => string;
}): Promise<void> {
  const name = opts.name ?? EXPECTED_PACKAGE_NAME;
  const registry = opts.registryUrl ?? EXPECTED_REGISTRY;
  assertRegistry(registry);
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const url = packumentUrl(name, registry);
  let status: number;
  let json: unknown = null;
  try {
    const res = await fetchFn(url, { headers: { Accept: "application/json" } });
    status = res.status;
    if (status !== 404) {
      try {
        json = await res.json();
      } catch {
        json = null;
      }
    }
  } catch (err) {
    throw new SlimExit(
      EXIT_FAIL,
      `npm packument fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (status === 404) {
    // name is unpublished — first publish may claim it
  } else if (status !== 200) {
    throw new SlimExit(EXIT_FAIL, `npm packument HTTP ${status} for ${name}`);
  } else {
    const versions =
      json && typeof json === "object" && json !== null && "versions" in json
        ? (json as { versions?: unknown }).versions
        : undefined;
    if (!versions || typeof versions !== "object") {
      throw new SlimExit(EXIT_FAIL, `npm packument for ${name} is missing versions`);
    }
    if (Object.prototype.hasOwnProperty.call(versions, opts.version)) {
      throw new SlimExit(
        EXIT_REFUSED,
        `npm ${name}@${opts.version} is already published (occupied)`,
      );
    }
  }

  const token = opts.token ?? process.env.NODE_AUTH_TOKEN ?? process.env.NPM_TOKEN ?? null;
  if (token) {
    try {
      const user = (opts.whoami ?? defaultWhoami)();
      if (!user) {
        throw new SlimExit(EXIT_ENV, "npm whoami returned an empty publisher identity");
      }
    } catch (err) {
      if (err instanceof SlimExit) throw err;
      throw new SlimExit(
        EXIT_ENV,
        `npm whoami failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
