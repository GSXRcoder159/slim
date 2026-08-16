import { runUpstream } from "../upstream.ts";
import { parseCli } from "../cli.ts";
const args = parseCli(["upstream", ...(process.env.SLIM_UPSTREAM_PR ? ["--pr"] : [])]);
process.exit(await runUpstream(args));
