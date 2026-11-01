import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

import { cancelBenchmark, compareReports, refreshReport, runBenchmark } from "./token-benchmark.js";

export async function runTokenBenchmarkCli(argv = process.argv): Promise<void> {
  const program = new Command()
    .name("benchmark:tokens")
    .description(
      "Measure Codex token usage with fixed tasks, explicit skills and manual quality review",
    )
    .option("--config <file>", "local benchmark configuration", "benchmarks/tokens.local.json")
    .option("--output <directory>", "output base directory (default: OS temporary storage)")
    .option("--check", "validate source, CLI and map workflow without calling a model")
    .action(async (options: { config: string; output?: string; check?: boolean }) => {
      const result = await runBenchmark(options.config, options.output, options.check);
      process.stdout.write(`${result.status}: ${result.directory}\n`);
      for (const error of result.errors) process.stderr.write(`${error}\n`);
      if (!["complete", "checked"].includes(result.status)) process.exitCode ||= 1;
    });
  program
    .command("report <directory>")
    .description("Update the report after filling the manual quality.json worksheet")
    .action(async (directory: string) => {
      const result = await refreshReport(directory);
      process.stdout.write(`${path.join(result.directory, "summary.md")}\n`);
    });
  program
    .command("compare <before> <after>")
    .description("Compare compatible saved runs; does not start model sessions")
    .action(async (before: string, after: string) => {
      process.stdout.write(`${JSON.stringify(await compareReports(before, after), null, 2)}\n`);
    });
  await program.parseAsync(argv);
}

if (process.argv[1] && (await fs.realpath(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const stop = (signal: NodeJS.Signals): void => {
    cancelBenchmark();
    process.exitCode = signal === "SIGINT" ? 130 : 143;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await runTokenBenchmarkCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode ||= 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
