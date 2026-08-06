import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import { repositoryRoot } from "./helpers.js";

function runSchemaCheck(): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["schema:check"], {
      cwd: repositoryRoot,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: unknown) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: unknown) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({
        status: status ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

describe("schema synchronization contract", () => {
  it("must keep checked-in JSON schemas synchronized with source Zod schemas", async () => {
    const result = await runSchemaCheck();
    const details = `pnpm schema:check failed with code ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    expect(result.status, details).toBe(0);
  });
});
