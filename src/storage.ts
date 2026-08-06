import { promises as fs } from "node:fs";
import path from "node:path";

import { z, type ZodType } from "zod";

import { MANAGED_ARTIFACTS, SCHEMA_VERSION } from "./constants.js";
import type { ResolvedConfiguration } from "./config.js";
import { CodeMapError, errorMessage } from "./errors.js";
import {
  CodeMapSchema,
  DiagnosticRecordSchema,
  FileRecordSchema,
  ManifestRecordSchema,
  ProjectRecordSchema,
  RelationRecordSchema,
  SymbolRecordSchema,
} from "./schemas.js";
import type { CodeMap, LoadCodeMapOptions } from "./types.js";
import { resolveConfiguration } from "./config.js";
import { atomicWriteIfChanged, isNotFound, stableJson, stableJsonLine } from "./utils/stable.js";

export async function writeCodeMap(
  resolved: ResolvedConfiguration,
  map: CodeMap,
): Promise<boolean> {
  const validated = parseWithSchema(CodeMapSchema, map, "generated code map");
  await fs.mkdir(resolved.outputDir, { recursive: true });
  let wrote = false;
  const write = async (
    name: (typeof MANAGED_ARTIFACTS)[number],
    content: string,
  ): Promise<void> => {
    wrote = (await atomicWriteIfChanged(path.join(resolved.outputDir, name), content)) || wrote;
  };

  // The manifest is committed last so readers never see a new manifest before its records exist.
  await write("overview.md", buildOverview(validated));
  await write("project.json", stableJson(validated.project, true));
  await write("files.jsonl", jsonLines(validated.files));
  await write("symbols.jsonl", jsonLines(validated.symbols));
  await write("relations.jsonl", jsonLines(validated.relations));
  await write("diagnostics.json", stableJson(validated.diagnostics, true));
  await write("manifest.json", stableJson(validated.manifest, true));
  return wrote;
}

export function buildOverview(map: CodeMap): string {
  const lines = [
    "# AI Code Map",
    "",
    `Project: ${map.project.name}`,
    `Frameworks: ${map.project.frameworks.join(", ") || "none detected"}`,
    "",
    "## Counts",
    "",
    `- Files: ${map.project.counts.files}`,
    `- Symbols: ${map.project.counts.symbols}`,
    `- Relations: ${map.project.counts.relations}`,
    `- Diagnostics: ${map.project.counts.diagnostics}`,
    "",
    "## Entry points",
    "",
    ...(map.project.entryPoints.length > 0
      ? map.project.entryPoints.map((entry) => `- ${entry}`)
      : ["- None declared in package.json"]),
    "",
    "## Indexed files",
    "",
    ...map.files.map(
      (file) =>
        `- ${file.path} (${file.symbolIds.length} symbols; ${file.frameworks.join(", ") || "generic"})`,
    ),
    "",
    "> This map is a navigation aid. Inspect the actual source before changing code; source is authoritative.",
    "",
  ];
  return lines.join("\n");
}

export async function loadCodeMap(options: LoadCodeMapOptions = {}): Promise<CodeMap> {
  const resolved = await resolveConfiguration(options);
  return loadCodeMapFrom(resolved.outputDir);
}

export async function loadCodeMapFrom(outputDir: string): Promise<CodeMap> {
  try {
    const [manifest, project, files, symbols, relations, diagnostics] = await Promise.all([
      readJson(path.join(outputDir, "manifest.json"), "manifest", ManifestRecordSchema),
      readJson(path.join(outputDir, "project.json"), "project", ProjectRecordSchema),
      readJsonLines(path.join(outputDir, "files.jsonl"), "file", FileRecordSchema),
      readJsonLines(path.join(outputDir, "symbols.jsonl"), "symbol", SymbolRecordSchema),
      readJsonLines(path.join(outputDir, "relations.jsonl"), "relation", RelationRecordSchema),
      readJson(
        path.join(outputDir, "diagnostics.json"),
        "diagnostics",
        z.array(DiagnosticRecordSchema),
      ),
    ]);
    const map = parseWithSchema(
      CodeMapSchema,
      {
        manifest,
        project,
        files,
        symbols,
        relations,
        diagnostics,
      },
      "persisted code map",
    );
    return map;
  } catch (error) {
    if (isNotFound(error)) {
      throw new CodeMapError(
        "MAP_NOT_FOUND",
        `No complete code map exists at ${outputDir}. Run ai-code-map scan.`,
      );
    }
    if (error instanceof CodeMapError) throw error;
    throw new CodeMapError(
      "MAP_READ_FAILED",
      `Could not load code map at ${outputDir}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function jsonLines(records: readonly unknown[]): string {
  if (records.length === 0) return "";
  return `${records.map(stableJsonLine).join("\n")}\n`;
}

async function readJson<T>(filePath: string, label: string, schema: ZodType<T>): Promise<T> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    return parseWithSchema(schema, raw, label);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CodeMapError(
        "INVALID_MAP",
        `Invalid JSON in ${label} artifact ${filePath}. Rescan the project.`,
      );
    }
    throw error;
  }
}

async function readJsonLines<T>(filePath: string, label: string, schema: ZodType<T>): Promise<T[]> {
  const text = await fs.readFile(filePath, "utf8");
  const records: T[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const raw: unknown = JSON.parse(line);
      records.push(parseWithSchema(schema, raw, `${label} at line ${index + 1}`));
    } catch (error) {
      if (error instanceof CodeMapError) throw error;
      throw new CodeMapError(
        "INVALID_MAP",
        `Invalid JSON in ${label} artifact ${filePath} at line ${index + 1}. Rescan the project.`,
      );
    }
  }
  return records;
}

function parseWithSchema<T>(schema: ZodType<T>, value: unknown, label: string): T {
  if (
    value &&
    typeof value === "object" &&
    "schemaVersion" in value &&
    (value as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION
  ) {
    throw new CodeMapError(
      "INCOMPATIBLE_SCHEMA",
      `Unsupported ${label} schema version ${String((value as { schemaVersion?: unknown }).schemaVersion)}; this build supports version ${SCHEMA_VERSION}. Run ai-code-map scan to regenerate the map.`,
    );
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || label}: ${issue.message}`)
    .join("; ");
  throw new CodeMapError(
    "INVALID_MAP",
    `Invalid ${label}: ${details}. Run ai-code-map scan to regenerate the map.`,
  );
}
