import { parentPort, workerData } from "node:worker_threads";

import { analyzeDefaultCompilerUnit } from "./analyze.js";
import type { CompilerWorkerInput } from "./analyze.js";

if (!parentPort) throw new Error("Compiler worker requires a parent port.");
const result = await analyzeDefaultCompilerUnit(workerData as CompilerWorkerInput);
parentPort.postMessage(result);
parentPort.close();
