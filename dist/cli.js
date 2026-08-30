import { parseArgs } from "node:util";
import { EXIT_FAIL, EXIT_OK, EXIT_USAGE, SlimExit } from "./exit.js";
import { errorDocument, writeErrorJson, writeJson } from "./json.js";
import { assertDocument } from "./schema/documents.js";
const HELP = `slim — delete your dependencies

Evidence, not proof. Slim infers the slice of a package you actually use,
emits a dependency-free replacement, differentially fuzzes it against the
original, and opens a PR with a standing regression suite.

Usage:
  slim scan [dir] [--json]
  slim inspect <pkg> [--json] [--allow-unknown]
  slim replace <pkg> [options]
  slim check [pkg] [--json]
  slim bloat
  slim upstream [--pr] [--json]
  slim watch                  (alias of upstream)
  slim doctor [--strict] [--json]

Replace options:
  --budget-ms <n>     extra-case quota n; 5s case stall after ready, 2000ms startup, 250ms shutdown (never the fake clock)
  --no-trace          skip tests; static-only evidence, never trace-closed
  --no-pr             write files; no branch, commit, push, or PR
  --allow-unknown     generate even with dynamic access (never claimed closed)
  --force             skip size / save heuristics
  --out <dir>         default src/slim; refuse unowned output and symlinked --out
  --dry-run           analyze and print; write nothing including traces
  --template-only     catalog only, no LLM
  --llm               force LLM even if catalog matches
  --keep-original     do not uninstall the package
  --no-install        rewrite package.json but skip lockfile refresh
  --allow-flaky       fuzz unseeded RNG packages (not production-ready evidence)
  --workers <n>       fuzz worker threads (default: CPUs-1; 1 = in-process)
  --seed <n>          deterministic fuzz seed
  --max-attempts <n>  LLM repair loop (default 3)

Doctor options:
  --strict            dirty working tree exits 4 (default: list it, still 0 if Node/hooks ok)

--json is supported on scan, inspect, check, upstream/watch, and doctor only.
replace does not support --json; machine output is .slim/<pkg>/evidence.json and .slim/manifest.json.
bloat does not support --json.

Exit codes: 0 ok  1 fail  2 usage  3 refused  4 environment
Streams: JSON and human reports on stdout. Progress, warnings, and errors on stderr.
`;
export function parseCli(argv) {
    if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
        return emptyArgs({ help: true, command: "help" });
    }
    const command = argv[0] === "watch" ? "upstream" : argv[0];
    const rest = argv.slice(1);
    const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        strict: false,
        options: {
            json: { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
            "budget-ms": { type: "string" },
            "no-trace": { type: "boolean", default: false },
            "no-pr": { type: "boolean", default: false },
            pr: { type: "boolean", default: false },
            "allow-unknown": { type: "boolean", default: false },
            force: { type: "boolean", default: false },
            out: { type: "string" },
            "dry-run": { type: "boolean", default: false },
            "template-only": { type: "boolean", default: false },
            llm: { type: "boolean", default: false },
            "keep-original": { type: "boolean", default: false },
            "no-install": { type: "boolean", default: false },
            "allow-flaky": { type: "boolean", default: false },
            workers: { type: "string" },
            seed: { type: "string" },
            "max-attempts": { type: "string" },
            strict: { type: "boolean", default: false },
        },
    });
    return {
        command,
        pkg: positionals[0] ?? null,
        json: Boolean(values.json),
        budgetMs: values["budget-ms"] ? Number(values["budget-ms"]) : null,
        noTrace: Boolean(values["no-trace"]),
        noPr: Boolean(values["no-pr"]),
        pr: Boolean(values.pr),
        allowUnknown: Boolean(values["allow-unknown"]),
        force: Boolean(values.force),
        out: values.out ?? null,
        dryRun: Boolean(values["dry-run"]),
        templateOnly: Boolean(values["template-only"]),
        llm: Boolean(values.llm),
        keepOriginal: Boolean(values["keep-original"]),
        noInstall: Boolean(values["no-install"]),
        allowFlaky: Boolean(values["allow-flaky"]),
        workers: values.workers ? Number(values.workers) : null,
        seed: values.seed ? Number(values.seed) : null,
        maxAttempts: values["max-attempts"] ? Number(values["max-attempts"]) : 3,
        help: Boolean(values.help),
        strict: Boolean(values.strict),
    };
}
function emptyArgs(over) {
    return {
        command: "help",
        pkg: null,
        json: false,
        budgetMs: null,
        noTrace: false,
        noPr: false,
        pr: false,
        allowUnknown: false,
        force: false,
        out: null,
        dryRun: false,
        templateOnly: false,
        llm: false,
        keepOriginal: false,
        noInstall: false,
        allowFlaky: false,
        workers: null,
        seed: null,
        maxAttempts: 3,
        help: false,
        strict: false,
        ...over,
    };
}
export const COMMAND_FLAGS = {
    scan: new Set(["json", "help"]),
    inspect: new Set(["json", "help", "allow-unknown"]),
    replace: new Set([
        "help",
        "budget-ms",
        "no-trace",
        "no-pr",
        "allow-unknown",
        "force",
        "out",
        "dry-run",
        "template-only",
        "llm",
        "keep-original",
        "no-install",
        "allow-flaky",
        "workers",
        "seed",
        "max-attempts",
    ]),
    check: new Set(["json", "help"]),
    bloat: new Set(["help"]),
    upstream: new Set(["json", "help", "pr"]),
    doctor: new Set(["json", "help", "strict"]),
};
export function flagsPresent(argv) {
    const flags = [];
    for (const a of argv) {
        if (a === "--")
            break;
        if (a === "-h" || a === "--help")
            flags.push("help");
        else if (a.startsWith("--"))
            flags.push(a.slice(2).split("=")[0]);
    }
    return flags;
}
export function assertCommandFlags(command, flags) {
    const allowed = COMMAND_FLAGS[command];
    if (!allowed)
        return;
    for (const flag of flags) {
        if (allowed.has(flag))
            continue;
        if (command === "replace" && flag === "json") {
            throw new SlimExit(EXIT_USAGE, "replace does not support --json; machine output is .slim/<pkg>/evidence.json and .slim/manifest.json");
        }
        if (command === "bloat" && flag === "json") {
            throw new SlimExit(EXIT_USAGE, "bloat does not support --json");
        }
        throw new SlimExit(EXIT_USAGE, `${command} does not support --${flag}`);
    }
}
export function helpText() {
    return HELP;
}
export async function runCli(argv) {
    const args = parseCli(argv);
    try {
        if (args.help || args.command === "help") {
            process.stdout.write(HELP);
            return EXIT_OK;
        }
        const known = [
            "scan",
            "inspect",
            "replace",
            "check",
            "bloat",
            "upstream",
            "doctor",
        ];
        if (!known.includes(args.command)) {
            const msg = `unknown command: ${args.command}`;
            process.stderr.write(`${msg}\n\n${HELP}`);
            if (args.json)
                writeErrorJson(EXIT_USAGE, msg);
            return EXIT_USAGE;
        }
        assertCommandFlags(args.command, flagsPresent(argv.slice(1)));
        switch (args.command) {
            case "doctor":
                return await (await import("./doctor.js")).runDoctor(args);
            case "scan":
                return await (await import("./scan.js")).runScan(args);
            case "inspect":
                return await (await import("./inspect.js")).runInspect(args);
            case "replace":
                return await (await import("./replace.js")).runReplace(args);
            case "check":
                return await (await import("./check.js")).runCheck(args);
            case "bloat":
                return (await import("./bloat.js")).runBloatCheck();
            case "upstream":
                return await (await import("./upstream.js")).runUpstream(args);
            default:
                return EXIT_USAGE;
        }
    }
    catch (err) {
        if (err instanceof SlimExit) {
            process.stderr.write(err.message + "\n");
            if (err.code === EXIT_USAGE)
                process.stderr.write(`\n${HELP}`);
            if (args.json && !err.skipJson) {
                const doc = err.json ?? errorDocument(err.code, err.message);
                assertDocument("error", doc);
                writeJson(doc);
            }
            return err.code;
        }
        const msg = err instanceof Error ? err.stack ?? err.message : String(err);
        process.stderr.write(msg + "\n");
        if (args.json)
            writeErrorJson(EXIT_FAIL, err instanceof Error ? err.message : String(err));
        return EXIT_FAIL;
    }
}
//# sourceMappingURL=cli.js.map