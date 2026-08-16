import { parseArgs } from "node:util";
import { EXIT_FAIL, EXIT_OK, EXIT_USAGE, SlimExit } from "./exit.ts";

const HELP = `slim — delete your dependencies

Evidence, not proof. Slim infers the slice of a package you actually use,
emits a dependency-free replacement, differentially fuzzes it against the
original, and opens a PR with a standing regression suite.

Usage:
  slim scan [--json]
  slim inspect <pkg>
  slim replace <pkg> [options]
  slim check
  slim upstream [--pr]
  slim watch                  (alias of upstream)
  slim doctor

Replace options:
  --budget-ms <n>     fuzz wall clock (default 30000, 300000 if CI=1)
  --no-trace          skip running tests for traces
  --no-pr             write files, do not open a GitHub PR
  --allow-unknown     generate even with dynamic access (never claimed closed)
  --force             skip size / save heuristics
  --out <dir>         default src/slim
  --dry-run           analyze and print, do not write
  --template-only     catalog only, no LLM
  --llm               force LLM even if catalog matches
  --keep-original     do not uninstall the package
  --no-install        rewrite package.json but skip lockfile refresh
  --allow-flaky       fuzz unseeded RNG packages
  --workers <n>
  --seed <n>
  --max-attempts <n>  LLM repair loop (default 3)

Exit codes: 0 ok  1 fail  2 usage  3 refused  4 environment
`;

export interface CliArgs {
  command: string;
  pkg: string | null;
  json: boolean;
  budgetMs: number | null;
  noTrace: boolean;
  noPr: boolean;
  pr: boolean;
  allowUnknown: boolean;
  force: boolean;
  out: string | null;
  dryRun: boolean;
  templateOnly: boolean;
  llm: boolean;
  keepOriginal: boolean;
  noInstall: boolean;
  allowFlaky: boolean;
  workers: number | null;
  seed: number | null;
  maxAttempts: number;
  help: boolean;
}

export function parseCli(argv: string[]): CliArgs {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    return emptyArgs({ help: true, command: "help" });
  }
  const command = argv[0] === "watch" ? "upstream" : argv[0]!;
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
    out: (values.out as string | undefined) ?? null,
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
  };
}

function emptyArgs(over: Partial<CliArgs>): CliArgs {
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
    ...over,
  };
}

export function helpText(): string {
  return HELP;
}

export async function runCli(argv: string[]): Promise<number> {
  try {
    const args = parseCli(argv);
    if (args.help || args.command === "help") {
      process.stdout.write(HELP);
      return EXIT_OK;
    }
    const known = [
      "scan",
      "inspect",
      "replace",
      "check",
      "upstream",
      "doctor",
    ];
    if (!known.includes(args.command)) {
      process.stderr.write(`unknown command: ${args.command}\n\n${HELP}`);
      return EXIT_USAGE;
    }
    switch (args.command) {
      case "doctor":
        return (await import("./doctor.ts")).runDoctor(args);
      case "scan":
        return (await import("./scan.ts")).runScan(args);
      case "inspect":
        return (await import("./inspect.ts")).runInspect(args);
      case "replace":
        return (await import("./replace.ts")).runReplace(args);
      case "check":
        return (await import("./check.ts")).runCheck(args);
      case "upstream":
        return (await import("./upstream.ts")).runUpstream(args);
      default:
        return EXIT_USAGE;
    }
  } catch (err) {
    if (err instanceof SlimExit) {
      process.stderr.write(err.message + "\n");
      return err.code;
    }
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(msg + "\n");
    return EXIT_FAIL;
  }
}
