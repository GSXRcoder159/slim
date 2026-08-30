import { runUpstream } from "../upstream.js";
import { parseCli } from "../cli.js";
const args = parseCli(["upstream", ...(process.env.SLIM_UPSTREAM_PR ? ["--pr"] : [])]);
process.exit(await runUpstream(args));
//# sourceMappingURL=upstream-action.js.map