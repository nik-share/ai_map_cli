#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { Command, CommanderError, Option } from "commander";
import packageJson from "../package.json" with { type: "json" };

import { initProject } from "./config.js";
import { CodeMapError, errorMessage } from "./errors.js";
import { checkFreshness } from "./freshness.js";
import { scanProject } from "./scan.js";
import { formatShowResult, showSymbol } from "./show.js";
import { loadCodeMap } from "./storage.js";
import type { LoadCodeMapOptions } from "./types.js";

interface CommonCliOptions {
  root?: string;
  config?: string;
  output?: string;
  json?: boolean;
  debug?: boolean;
}

export async function runCli(argv = process.argv): Promise<number> {
  const program = createProgram();
  let exitCode = 0;
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
  });

  const initCommand = program
    .command("init")
    .description("Create a missing ai-code-map configuration")
    .option("--force", "overwrite an existing configuration", false)
    .addOption(new Option("--json", "print machine-readable output"))
    .action(async (options: CommonCliOptions & { force: boolean }, command: Command) => {
      const common = collectOptions(command);
      const result = await initProject({ ...loadOptions(common), force: options.force });
      if (common.json) printJson(result);
      else if (result.created) process.stdout.write(`Created ${result.configPath}\n`);
      else
        process.stdout.write(`Configuration already exists at ${result.configPath}; unchanged.\n`);
    });
  addCommonOptions(initCommand);

  const scanCommand = program
    .command("scan")
    .description("Analyze the project and write a deterministic local code map")
    .option("--strict", "return exit code 3 when parse errors are present", false)
    .addOption(new Option("--json", "print machine-readable output"))
    .action(async (options: CommonCliOptions & { strict: boolean }, command: Command) => {
      const common = collectOptions(command);
      const result = await scanProject({ ...loadOptions(common), strict: options.strict });
      if (common.json) {
        printJson({
          root: result.root,
          outputDir: result.outputDir,
          wrote: result.wrote,
          changes: result.changes,
          elapsedMs: result.elapsedMs,
          counts: result.counts,
          criticalParseErrors: result.criticalParseErrors,
        });
      } else {
        process.stdout.write(
          `Scanned ${result.counts.files} files, ${result.counts.symbols} symbols, ${result.counts.relations} relations, ${result.counts.diagnostics} diagnostics in ${result.elapsedMs}ms.\n${result.wrote ? `Updated ${result.outputDir}.` : "Map was already current; no artifacts changed."}\n`,
        );
      }
      if (options.strict && result.criticalParseErrors) exitCode = 3;
    });
  addCommonOptions(scanCommand);

  const checkCommand = program
    .command("check")
    .description("Check whether the persisted code map is current")
    .addOption(new Option("--json", "print machine-readable output"))
    .action(async (_options: CommonCliOptions, command: Command) => {
      const common = collectOptions(command);
      const result = await checkFreshness(loadOptions(common));
      if (common.json) printJson(result);
      else
        process.stdout.write(
          `${result.current ? "Current" : "Stale"}: ${result.reasons.join(" ")}\n`,
        );
      if (!result.current) exitCode = 2;
    });
  addCommonOptions(checkCommand);

  const showCommand = program
    .command("show")
    .description("Show one indexed symbol by stable ID, kind:name, path, or exact name")
    .argument("<symbol>", "symbol selector")
    .addOption(new Option("--json", "print machine-readable output"))
    .action(async (selector: string, _options: CommonCliOptions, command: Command) => {
      const common = collectOptions(command);
      const map = await loadCodeMap(loadOptions(common));
      const result = showSymbol(map, selector);
      if (result.matches.length === 0) {
        throw new CodeMapError(
          "SYMBOL_NOT_FOUND",
          `No indexed symbol matches ${selector}. Run ai-code-map scan, then use an exact name or stable ID.`,
        );
      }
      if (common.json) printJson(result);
      else process.stdout.write(`${formatShowResult(result)}\n`);
    });
  addCommonOptions(showCommand);

  try {
    await program.parseAsync(argv);
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return 0;
      if (error.code === "commander.unknownCommand" || error.code === "commander.missingArgument")
        return 1;
    }
    const debug = argv.includes("--debug");
    process.stderr.write(
      `${debug && error instanceof Error ? error.stack : errorMessage(error)}\n`,
    );
    return 1;
  }
}

function createProgram(): Command {
  return new Command()
    .name("ai-code-map")
    .description(
      "Generate a deterministic local semantic map of TypeScript and JavaScript projects",
    )
    .version(packageJson.version)
    .showHelpAfterError()
    .addOption(new Option("--debug", "show stack traces for failures").hideHelp());
}

function addCommonOptions(command: Command): void {
  command
    .option("--root <path>", "project path (nearest package.json is used)")
    .option("--config <path>", "configuration path, relative to --root/current directory")
    .option("--output <path>", "map output directory, relative to the project root")
    .addOption(new Option("--debug", "show stack traces for failures").hideHelp());
}

function collectOptions(command: Command): CommonCliOptions {
  return command.opts<CommonCliOptions>();
}

function loadOptions(options: CommonCliOptions): LoadCodeMapOptions {
  return {
    ...(options.root ? { root: options.root } : {}),
    ...(options.config ? { config: options.config } : {}),
    ...(options.output ? { output: options.output } : {}),
  };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  process.exitCode = await runCli();
}
