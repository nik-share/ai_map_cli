import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import type { CompilerWorkerInput, CompilerWorkerResult } from "./analyze.js";

export function runCompilerUnitWorker(input: CompilerWorkerInput): Promise<CompilerWorkerResult> {
  let entry = new URL("./compiler-worker.js", import.meta.url);
  if (import.meta.url.endsWith(".ts")) {
    // Source execution (tsx/Vitest) uses the development loader; packed code needs only Node.
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href;
    const source = new URL("./compiler-worker.ts", import.meta.url).href;
    const bootstrap = `import { tsImport } from ${JSON.stringify(loader)}; await tsImport(${JSON.stringify(source)}, ${JSON.stringify(import.meta.url)});`;
    entry = new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`);
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(entry, { workerData: input });
    let result: CompilerWorkerResult | undefined;
    worker.once("message", (message: CompilerWorkerResult) => {
      result = message;
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0 || !result) {
        reject(new Error(`Compiler worker exited without a complete result (code ${code}).`));
      } else {
        resolve(result);
      }
    });
  });
}
