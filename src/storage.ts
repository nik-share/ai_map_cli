import { promises as fs } from "node:fs";
import path from "node:path";

import { z, type ZodType } from "zod";

import { MANAGED_ARTIFACTS, MAP_COMPANION_ARTIFACTS, SCHEMA_VERSION } from "./constants.js";
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
import type { CodeMap, LoadCodeMapOptions, ManifestRecord } from "./types.js";
import { resolveConfiguration } from "./config.js";
import { hashText } from "./utils/hash.js";
import { atomicWriteIfChanged, isNotFound, stableJson, stableJsonLine } from "./utils/stable.js";

type CompanionArtifact = (typeof MAP_COMPANION_ARTIFACTS)[number];
type CompanionContents = Record<CompanionArtifact, string>;

export async function writeCodeMap(
  resolved: ResolvedConfiguration,
  map: CodeMap,
): Promise<{ wrote: boolean; map: CodeMap }> {
  const validated = finalizeCodeMap(map);
  const contents = buildCompanionContents(validated);
  await fs.mkdir(resolved.outputDir, { recursive: true });
  let wrote = false;
  const write = async (
    name: (typeof MANAGED_ARTIFACTS)[number],
    content: string,
  ): Promise<void> => {
    wrote = (await atomicWriteIfChanged(path.join(resolved.outputDir, name), content)) || wrote;
  };

  // The manifest is committed last so readers never see a new manifest before its records exist.
  for (const name of MAP_COMPANION_ARTIFACTS) await write(name, contents[name]);
  await write("manifest.json", stableJson(validated.manifest, true));
  return { wrote, map: validated };
}

export function finalizeCodeMap(map: CodeMap): CodeMap {
  const withoutIntegrity: CodeMap = {
    ...map,
    manifest: { ...map.manifest, artifacts: [], integrityHash: "0".repeat(64) },
  };
  const contents = buildCompanionContents(withoutIntegrity);
  const manifestWithArtifacts: ManifestRecord = {
    ...withoutIntegrity.manifest,
    artifacts: MAP_COMPANION_ARTIFACTS.map((artifactPath) => ({
      path: artifactPath,
      hash: hashText(Buffer.from(contents[artifactPath], "utf8")),
    })),
  };
  const finalized: CodeMap = {
    ...withoutIntegrity,
    manifest: {
      ...manifestWithArtifacts,
      integrityHash: computeManifestIntegrityHash(manifestWithArtifacts),
    },
  };
  return parseWithSchema(CodeMapSchema, finalized, "generated code map");
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
    const manifest = await readJson(
      path.join(outputDir, "manifest.json"),
      "manifest",
      ManifestRecordSchema,
    );
    verifyManifestIntegrity(manifest, outputDir);
    const rawEntries = await Promise.all(
      MAP_COMPANION_ARTIFACTS.map(
        async (name) => [name, await fs.readFile(path.join(outputDir, name))] as const,
      ),
    );
    const raw = Object.fromEntries(rawEntries) as Record<CompanionArtifact, Buffer>;
    verifyArtifactIntegrity(manifest, raw, outputDir);

    const overview = raw["overview.md"].toString("utf8");
    const project = parseJsonBuffer(raw["project.json"], "project", ProjectRecordSchema);
    const files = parseJsonLinesBuffer(raw["files.jsonl"], "file", FileRecordSchema);
    const symbols = parseJsonLinesBuffer(raw["symbols.jsonl"], "symbol", SymbolRecordSchema);
    const relations = parseJsonLinesBuffer(
      raw["relations.jsonl"],
      "relation",
      RelationRecordSchema,
    );
    const diagnostics = parseJsonBuffer(
      raw["diagnostics.json"],
      "diagnostics",
      z.array(DiagnosticRecordSchema),
    );
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
    if (overview !== buildOverview(map)) {
      throw new CodeMapError(
        "INVALID_MAP",
        `The overview artifact at ${outputDir} does not match the persisted code map. Rescan the project.`,
      );
    }
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

function buildCompanionContents(map: CodeMap): CompanionContents {
  return {
    "overview.md": buildOverview(map),
    "project.json": stableJson(map.project, true),
    "files.jsonl": jsonLines(map.files),
    "symbols.jsonl": jsonLines(map.symbols),
    "relations.jsonl": jsonLines(map.relations),
    "diagnostics.json": stableJson(map.diagnostics, true),
  };
}

function verifyArtifactIntegrity(
  manifest: ManifestRecord,
  raw: Record<CompanionArtifact, Buffer>,
  outputDir: string,
): void {
  const declared = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact.hash]));
  if (
    declared.size !== MAP_COMPANION_ARTIFACTS.length ||
    MAP_COMPANION_ARTIFACTS.some((name) => !declared.has(name))
  ) {
    throw new CodeMapError(
      "INVALID_MAP",
      `Invalid persisted code map: the manifest at ${outputDir} does not cover the complete companion artifact set. Rescan the project.`,
    );
  }
  for (const name of MAP_COMPANION_ARTIFACTS) {
    if (declared.get(name) !== hashText(raw[name])) {
      throw new CodeMapError(
        "INVALID_MAP",
        `Invalid persisted code map: the ${name} artifact at ${outputDir} does not match its manifest hash. Rescan the project.`,
      );
    }
  }
}

export function computeManifestIntegrityHash(manifest: ManifestRecord): string {
  const content: Record<string, unknown> = { ...manifest };
  delete content.integrityHash;
  return hashText(Buffer.from(stableJson(content), "utf8"));
}

function verifyManifestIntegrity(manifest: ManifestRecord, outputDir: string): void {
  if (manifest.integrityHash !== computeManifestIntegrityHash(manifest)) {
    throw new CodeMapError(
      "INVALID_MAP",
      `Invalid persisted code map: the manifest integrity hash at ${outputDir} is inconsistent. Rescan the project.`,
    );
  }
}

/** Read only the commit-marker artifact for freshness/change checks without retaining the map. */
export async function loadManifestFrom(outputDir: string): Promise<ManifestRecord> {
  try {
    const manifest = await readJson(
      path.join(outputDir, "manifest.json"),
      "manifest",
      ManifestRecordSchema,
    );
    verifyManifestIntegrity(manifest, outputDir);
    return manifest;
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
      `Could not load code map manifest at ${outputDir}: ${errorMessage(error)}`,
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
    return parseJsonBuffer(await fs.readFile(filePath), label, schema);
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

function parseJsonBuffer<T>(contents: Buffer, label: string, schema: ZodType<T>): T {
  try {
    const raw: unknown = JSON.parse(contents.toString("utf8"));
    return parseWithSchema(schema, raw, label);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CodeMapError(
        "INVALID_MAP",
        `Invalid JSON in ${label} artifact. Rescan the project.`,
      );
    }
    throw error;
  }
}

function parseJsonLinesBuffer<T>(
  contents: Buffer,
  label: string,
  schema: ZodType<T>,
  filePath = label,
): T[] {
  const text = contents.toString("utf8");
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
