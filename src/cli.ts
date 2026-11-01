#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { Command, CommanderError, Option } from "commander";
import packageJson from "../package.json" with { type: "json" };

import { initProject, resolveConfiguration } from "./config.js";
import { CodeMapError, errorMessage } from "./errors.js";
import { checkFreshness } from "./freshness.js";
import { scanProject } from "./scan.js";
import { findSymbols, type SymbolSearchResult } from "./search.js";
import { formatShowResult, showSymbol } from "./show.js";
import { readSymbolSource } from "./read.js";
import { loadCodeMap, loadCodeMapFrom } from "./storage.js";
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

  const findCommand = program
    .command("find")
    .description("Find indexed symbols by name, path, words, or a likely typo")
    .argument("<query>", "search query (quote multiple words)")
    .option("--limit <number>", "maximum matches, 1..50", parseLimit, 10)
    .option("--json", "print machine-readable output")
    .action(
      async (query: string, options: CommonCliOptions & { limit: number }, command: Command) => {
        const map = await loadCodeMap(loadOptions(collectOptions(command)));
        const result = findSymbols(map, query, { limit: options.limit });
        if (options.json) printJson(result);
        else process.stdout.write(`${formatSearchResult(result)}\n`);
      },
    );
  addCommonOptions(findCommand);

  const readCommand = program
    .command("read")
    .description("Read a bounded source range using an exact symbol ID from the map")
    .argument("<id>", "exact stable symbol ID from find")
    .option("--limit <number>", "maximum source lines, 1..200", Number, 80)
    .option("--offset <number>", "line offset within the symbol window", Number, 0)
    .option("--json", "print source and continuation metadata as JSON")
    .action(
      async (
        id: string,
        options: CommonCliOptions & { limit: number; offset: number },
        command: Command,
      ) => {
        const common = collectOptions(command);
        const resolved = await resolveConfiguration(loadOptions(common));
        const map = await loadCodeMapFrom(resolved.outputDir);
        const result = await readSymbolSource(map, id, {
          root: resolved.root,
          limit: options.limit,
          offset: options.offset,
        });
        if (options.json) printJson(result);
        else {
          const location = ["root", "config", "output"] as const;
          const suffix = location
            .map((key) => {
              const value = common[key];
              return value ? ` --${key} ${shellQuote(value)}` : "";
            })
            .join("");
          const numbered = result.source
            .split("\n")
            .map((line, index) => `${result.startLine + index}: ${line}`);
          process.stdout.write(
            [
              `${result.id}\n${result.file}:${result.startLine}-${result.endLine}`,
              ...numbered,
              result.truncated
                ? `More source remains. Continue: ai-code-map read ${shellQuote(result.id)} --offset ${result.nextOffset} --limit ${options.limit}${suffix}`
                : "End of symbol window.",
            ].join("\n") + "\n",
          );
        }
      },
    );
  addCommonOptions(readCommand);

  const showCommand = program
    .command("show")
    .description("Show one indexed symbol by stable ID, kind:name, path, or exact name")
    .argument("<symbol>", "symbol selector")
    .option("--full", "print verbose symbol details and relations")
    .option("--limit <number>", "maximum relation groups in compact text, 1..50", parseLimit, 12)
    .addOption(new Option("--json", "print machine-readable output"))
    .action(
      async (
        selector: string,
        options: CommonCliOptions & { full?: boolean; limit: number },
        command: Command,
      ) => {
        const common = collectOptions(command);
        const map = await loadCodeMap(loadOptions(common));
        const result = showSymbol(map, selector);
        if (result.matches.length === 0) {
          const suggestions = selector.trim()
            ? findSymbols(map, selector, { limit: 5 })
            : undefined;
          throw new CodeMapError(
            "SYMBOL_NOT_FOUND",
            `No indexed symbol matches ${selector}. ${suggestions?.matches.length ? `Did you mean:\n${formatSearchResult(suggestions)}` : 'Use ai-code-map find "words" to discover a selector, or rg if the symbol is not indexed.'}`,
          );
        }
        if (common.json) printJson(result);
        else process.stdout.write(`${formatShowResult(result, { ...options })}\n`);
      },
    );
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

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseLimit(value: string): number {
  const limit = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError("limit must be an integer between 1 and 50");
  }
  return limit;
}

function formatSearchResult(result: SymbolSearchResult): string {
  return [
    `Symbols: ${result.matches.length}/${result.total} shown${result.truncated ? "; refine the query for omitted matches" : ""}`,
    ...result.matches.map(
      ({ id, kind, file, range, unmatchedTerms }) =>
        `${id} [${kind}]${unmatchedTerms?.length ? ` (partial; unmatched: ${unmatchedTerms.join(", ")})` : ""}\n  ${file}:${range.startLine}:${range.startColumn}-${range.endLine}:${range.endColumn}`,
    ),
    result.matches.length
      ? "Use ai-code-map read '<id>' for bounded source; show '<id>' for relations."
      : "No matches. Try other words or use rg; only indexed symbols are searchable.",
  ].join("\n");
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  process.exitCode = await runCli();
}
