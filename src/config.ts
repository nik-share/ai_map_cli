import { promises as fs } from "node:fs";
import path from "node:path";

import { CONFIG_VERSION, DEFAULT_EXCLUDE, DEFAULT_INCLUDE, DEFAULT_OUTPUT } from "./constants.js";
import { CodeMapError, errorMessage } from "./errors.js";
import { ConfigSchema } from "./schemas.js";
import type { CodeMapConfig, FrameworkSelection, LoadCodeMapOptions } from "./types.js";
import { isSafeRegularFile, toPosixPath } from "./utils/path.js";
import { atomicWriteIfChanged, isNotFound, stableJson } from "./utils/stable.js";

export interface ResolvedConfiguration {
  root: string;
  outputDir: string;
  configPath: string;
  config: CodeMapConfig;
  configExists: boolean;
}

export interface InitOptions extends LoadCodeMapOptions {
  force?: boolean;
}

export interface InitResult {
  root: string;
  configPath: string;
  created: boolean;
}

export function createDefaultConfig(
  root: string,
  configPath: string,
  output?: string,
): CodeMapConfig {
  const configDirectory = path.dirname(configPath);
  const relativeRoot = toPosixPath(path.relative(configDirectory, root) || ".");
  const outputValue = output
    ? path.isAbsolute(output)
      ? toPosixPath(path.relative(root, output))
      : toPosixPath(output)
    : DEFAULT_OUTPUT;
  return {
    version: CONFIG_VERSION,
    root: relativeRoot,
    include: [...DEFAULT_INCLUDE],
    exclude: [...DEFAULT_EXCLUDE],
    tsconfig: "tsconfig.json",
    frameworks: ["auto"],
    output: outputValue,
    includePrivateSymbols: false,
  };
}

export async function findProjectRoot(start = process.cwd()): Promise<string> {
  let current = path.resolve(start);
  try {
    if (!(await fs.stat(current)).isDirectory()) current = path.dirname(current);
  } catch (error) {
    throw new CodeMapError("ROOT_NOT_FOUND", `Cannot access project root candidate ${current}.`, {
      cause: error,
    });
  }

  while (current !== path.dirname(current)) {
    const packagePath = path.join(current, "package.json");
    if (await isSafeRegularFile(current, packagePath)) {
      return await fs.realpath(current);
    }
    const parent = path.dirname(current);
    current = parent;
  }
  throw new CodeMapError(
    "PROJECT_NOT_FOUND",
    `No package.json was found at or above ${path.resolve(start)}. Pass --root explicitly.`,
  );
}

function resolveConfigArgument(base: string, config?: string): string {
  if (!config) return path.join(base, DEFAULT_OUTPUT, "config.json");
  return path.resolve(base, config);
}

export async function resolveConfiguration(
  options: LoadCodeMapOptions = {},
): Promise<ResolvedConfiguration> {
  const requestedStart = path.resolve(options.root ?? process.cwd());
  const discoveredRoot = await findProjectRoot(requestedStart);
  const configPath = options.config
    ? resolveConfigArgument(requestedStart, options.config)
    : path.join(
        options.output
          ? path.resolve(discoveredRoot, options.output)
          : path.join(discoveredRoot, DEFAULT_OUTPUT),
        "config.json",
      );
  let parsed: CodeMapConfig;
  let configExists = true;
  try {
    const raw: unknown = JSON.parse(await fs.readFile(configPath, "utf8"));
    const result = ConfigSchema.safeParse(raw);
    if (!result.success) {
      const details = result.error.issues
        .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
        .join("; ");
      throw new CodeMapError(
        "INVALID_CONFIG",
        `Invalid configuration at ${configPath}: ${details}`,
      );
    }
    parsed = result.data;
  } catch (error) {
    if (isNotFound(error)) {
      configExists = false;
      parsed = createDefaultConfig(discoveredRoot, configPath, options.output);
    } else if (error instanceof SyntaxError) {
      throw new CodeMapError("INVALID_CONFIG", `Invalid JSON in ${configPath}: ${error.message}`);
    } else {
      throw error;
    }
  }

  const configuredRoot = configExists
    ? path.resolve(path.dirname(configPath), parsed.root)
    : discoveredRoot;
  let root: string;
  try {
    root = await fs.realpath(configuredRoot);
  } catch (error) {
    throw new CodeMapError(
      "ROOT_NOT_FOUND",
      `Configured project root cannot be resolved: ${configuredRoot}.`,
      { cause: error },
    );
  }
  const outputValue = options.output ?? parsed.output;
  const outputDir = path.isAbsolute(outputValue)
    ? path.normalize(outputValue)
    : path.resolve(root, outputValue);
  return { root, outputDir, configPath, config: parsed, configExists };
}

export async function initProject(options: InitOptions = {}): Promise<InitResult> {
  const requestedStart = path.resolve(options.root ?? process.cwd());
  const root = await findProjectRoot(requestedStart);
  const defaultOutputDir = options.output
    ? path.resolve(root, options.output)
    : path.join(root, DEFAULT_OUTPUT);
  const configPath = options.config
    ? path.resolve(requestedStart, options.config)
    : path.join(defaultOutputDir, "config.json");

  try {
    await fs.access(configPath);
    if (!options.force) return { root, configPath, created: false };
  } catch (error) {
    if (!isNotFound(error)) {
      throw new CodeMapError(
        "CONFIG_ACCESS_FAILED",
        `Cannot access ${configPath}: ${errorMessage(error)}`,
      );
    }
  }

  const config = createDefaultConfig(root, configPath, options.output);
  await atomicWriteIfChanged(configPath, stableJson(config, true));
  return { root, configPath, created: true };
}

export function effectiveFrameworks(
  configured: FrameworkSelection[],
  detected: Exclude<FrameworkSelection, "auto">[],
): Exclude<FrameworkSelection, "auto">[] {
  const selected = configured.includes("auto")
    ? [...detected]
    : configured.filter((entry): entry is Exclude<FrameworkSelection, "auto"> => entry !== "auto");
  return [...new Set(selected)].sort();
}
