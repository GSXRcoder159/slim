import { parseCli } from "../cli.ts";
import { runCheck } from "../check.ts";
process.exit(await runCheck(parseCli(["check"])));
