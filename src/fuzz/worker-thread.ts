import { parentPort, workerData } from "node:worker_threads";
import { loadOrig, loadSlim, runJob, type FuzzJob } from "./workers.ts";

const origModule = (workerData as { origModule: string }).origModule;
const slimModule = (workerData as { slimModule: string }).slimModule;

const ready = Promise.all([loadOrig(origModule), loadSlim(slimModule)]);

parentPort?.on("message", async (msg: { type: string; id?: number; job?: FuzzJob }) => {
  if (msg.type !== "run" || msg.id === undefined || !msg.job) return;
  try {
    const [orig, slim] = await ready;
    const result = await runJob(orig, slim, msg.job);
    parentPort?.postMessage({ type: "result", id: msg.id, result });
  } catch (e) {
    parentPort?.postMessage({
      type: "error",
      id: msg.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});
