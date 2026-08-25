import { parentPort, workerData } from "node:worker_threads";
import { createFakeClock } from "./clock.ts";
import { loadOrig, loadSlim, runJob, fromCloneableJob, toCloneableResult, type FuzzJob } from "./workers.ts";

const data = workerData as {
  origModule: string;
  slimModule: string;
  symbols?: string[];
  clock?: boolean;
  projectRoot?: string;
};

const origModule = data.origModule;
const slimModule = data.slimModule;

// Install fake clock in worker_data before importing orig/slim so lodash
// caches FakeDate / patched Date.now instead of the native constructors.
const workerClock = createFakeClock(0);
if (data.clock) workerClock.install();

const ready = Promise.all([loadOrig(origModule, data.projectRoot), loadSlim(slimModule)]);

parentPort?.on("message", async (msg: { type: string; id?: number; job?: FuzzJob }) => {
  if (msg.type !== "run" || msg.id === undefined || !msg.job) {
    if (msg.id !== undefined) {
      parentPort?.postMessage({
        type: "error",
        id: msg.id,
        error: "malformed worker message",
      });
    }
    return;
  }
  try {
    const [orig, slim] = await ready;
    const result = await runJob(orig, slim, fromCloneableJob(msg.job), data.clock ? workerClock : undefined);
    parentPort?.postMessage({ type: "result", id: msg.id, result: toCloneableResult(result) });
  } catch (e) {
    parentPort?.postMessage({
      type: "error",
      id: msg.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});
