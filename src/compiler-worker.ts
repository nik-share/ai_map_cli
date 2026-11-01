import { Session } from "node:inspector/promises";
import { parentPort, workerData } from "node:worker_threads";

import { analyzeDefaultCompilerUnit } from "./analyze.js";
import type { CompilerWorkerInput } from "./analyze.js";

if (!parentPort) throw new Error("Compiler worker requires a parent port.");
const result = await analyzeDefaultCompilerUnit(workerData as CompilerWorkerInput);
// Reclaim the unreachable compiler before cloning its normalized result into the parent heap.
// This session is local to the worker; it does not open an inspector port.
const session = new Session();
session.connect();
try {
  await session.post("HeapProfiler.collectGarbage");
} finally {
  session.disconnect();
}
parentPort.postMessage(result);
parentPort.close();
