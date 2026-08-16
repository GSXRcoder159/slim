import { createHash } from "node:crypto";
import type { Envelope } from "../envelope/types.ts";

export function buildPrompt(env: Envelope, publicApi: string, counterexamples: string[]): {
  system: string;
  user: string;
  promptHash: string;
} {
  const system = `You write a clean-room TypeScript module that implements ONLY the used exports in the envelope.
Rules:
- Original implementation. Not derived from lodash, Underscore, moment, or any original .js.
- No eval, Function, WebAssembly, import(), require, node: builtins, fetch, Proxy, string-setTimeout.
- Look up Date.now, setTimeout, clearTimeout at call time. Never cache timers at module init.
- Named exports for each symbol. If the envelope used default or namespace import, also export default { ... }.
- Harden __proto__/constructor/prototype on get/set/has.
- get defaultValue only when resolved value === undefined (null is a hit). Nested get returns the same reference.
- debounce: TypeError('Expected a function'); cancel+flush only (no pending); omitted options is not {}; leading&&trailing with one call does not trailing.
- Evidence, not proof: implement the envelope, not the whole library.
Return ONLY the TypeScript module.`;
  const user = [
    "Envelope JSON:",
    JSON.stringify(
      {
        package: env.package,
        symbols: env.symbols.map((s) => ({
          exportName: s.exportName,
          callSites: s.callSites.map((c) => ({
            argc: c.argc,
            argShapes: c.argShapes,
            thisBinding: c.thisBinding,
            resultMembers: c.resultMembers,
          })),
          resultMembers: s.resultMembers,
          hyrum: s.hyrum,
        })),
        clock: env.clock,
        cryptoRandom: env.cryptoRandom,
      },
      null,
      2,
    ),
    "",
    "Public API (.d.ts / README excerpt):",
    publicApi.slice(0, 12_000),
    "",
    counterexamples.length ? "Previous disagreements to fix:" : "",
    ...counterexamples,
  ].join("\n");
  const promptHash = createHash("sha256").update(system + "\n" + user).digest("hex");
  return { system, user, promptHash };
}
