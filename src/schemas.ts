import path from "node:path";

import { z } from "zod";

import {
  CONFIG_VERSION,
  DEFAULT_EXCLUDE,
  DEFAULT_INCLUDE,
  DEFAULT_OUTPUT,
  MAP_COMPANION_ARTIFACTS,
  SCHEMA_VERSION,
} from "./constants.js";
import {
  hasEmbeddedAbsolutePath,
  isAbsolutePath,
  normalizeStoredPath,
  toPosixPath,
} from "./utils/path.js";
import { compareText, stableJson } from "./utils/stable.js";

export const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;
export type JsonPrimitive = Extract<JsonValue, string | number | boolean | null>;

export const LanguageSchema = z.enum(["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"]);
export type Language = z.infer<typeof LanguageSchema>;

export const FrameworkSchema = z.enum(["typescript", "node", "react", "nextjs", "nestjs"]);
export type Framework = z.infer<typeof FrameworkSchema>;

export const FrameworkSelectionSchema = z.union([FrameworkSchema, z.literal("auto")]);
export type FrameworkSelection = z.infer<typeof FrameworkSelectionSchema>;

export const ConfigSchema = z
  .object({
    version: z.literal(CONFIG_VERSION).default(CONFIG_VERSION),
    root: z.string().min(1).default("../.."),
    include: z
      .array(z.string().min(1))
      .min(1)
      .default([...DEFAULT_INCLUDE]),
    exclude: z.array(z.string().min(1)).default([...DEFAULT_EXCLUDE]),
    tsconfig: z.string().min(1).optional(),
    frameworks: z.array(FrameworkSelectionSchema).min(1).default(["auto"]),
    output: z.string().min(1).default(DEFAULT_OUTPUT),
    includePrivateSymbols: z.boolean().default(false),
    concurrency: z.number().int().min(1).max(64).optional(),
  })
  .strict()
  .superRefine((config, context) => {
    if (new Set(config.frameworks).size !== config.frameworks.length) {
      context.addIssue({
        code: "custom",
        path: ["frameworks"],
        message: "framework selections must be unique",
      });
    }
    if (config.frameworks.includes("auto") && config.frameworks.length > 1) {
      context.addIssue({
        code: "custom",
        path: ["frameworks"],
        message: "auto cannot be combined with explicit framework selections",
      });
    }
  });
export type CodeMapConfig = z.infer<typeof ConfigSchema>;

export const SourceRangeSchema = z
  .object({
    startLine: z.number().int().positive(),
    startColumn: z.number().int().positive(),
    endLine: z.number().int().positive(),
    endColumn: z.number().int().positive(),
  })
  .strict()
  .superRefine((range, context) => {
    if (
      range.endLine < range.startLine ||
      (range.endLine === range.startLine && range.endColumn < range.startColumn)
    ) {
      context.addIssue({ code: "custom", message: "range end must not precede its start" });
    }
  });
export type SourceRange = z.infer<typeof SourceRangeSchema>;

export const StoredPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.startsWith("/") &&
      !hasEmbeddedAbsolutePath(value) &&
      !value.split("/").includes(".."),
    "must be a repository-relative POSIX path",
  )
  .refine((value) => value === normalizeStoredPath(value), "must be normalized");

const StoredFilePathSchema = StoredPathSchema.refine(
  (value) => value !== ".",
  "must identify a file or non-root project path",
);

const StoredModuleAliasSchema = z
  .string()
  .min(1)
  .refine(
    (value) => !isAbsolutePath(value) && !toPosixPath(value).split("/").includes(".."),
    "must not contain an absolute or parent-traversing path",
  );

export const ImportSpecifierRecordSchema = z
  .object({
    imported: z.string(),
    local: z.string(),
    typeOnly: z.boolean().optional(),
  })
  .strict();
export type ImportSpecifierRecord = z.infer<typeof ImportSpecifierRecordSchema>;

export const ImportRecordSchema = z
  .object({
    source: z
      .string()
      .min(1)
      .refine((value) => !isAbsolutePath(value), "must not expose an absolute module path"),
    specifiers: z.array(ImportSpecifierRecordSchema),
    resolved: StoredFilePathSchema.optional(),
    external: z.boolean(),
    kind: z.enum(["esm", "commonjs"]),
    line: z.number().int().positive(),
  })
  .strict();
export type ImportRecord = z.infer<typeof ImportRecordSchema>;

export const ExportRecordSchema = z
  .object({
    name: z.string(),
    local: z.string().optional(),
    source: z
      .string()
      .refine((value) => !isAbsolutePath(value), "must not expose an absolute module path")
      .optional(),
    default: z.boolean(),
    typeOnly: z.boolean().optional(),
    line: z.number().int().positive(),
  })
  .strict();
export type ExportRecord = z.infer<typeof ExportRecordSchema>;

export const ExternalOperationKindSchema = z.enum(["filesystem", "http", "database", "queue"]);
export type ExternalOperationKind = z.infer<typeof ExternalOperationKindSchema>;

export const ExternalOperationSchema = z
  .object({
    kind: ExternalOperationKindSchema,
    api: z.string().min(1),
    line: z.number().int().positive(),
  })
  .strict();
export type ExternalOperation = z.infer<typeof ExternalOperationSchema>;

export const SyntaxSummarySchema = z
  .object({
    parser: z.string().min(1),
    factCount: z.number().int().nonnegative(),
    hadErrors: z.boolean(),
    fallbackFrom: z.string().min(1).optional(),
  })
  .strict();
export type SyntaxSummary = z.infer<typeof SyntaxSummarySchema>;

export const FileRecordSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: z.string().min(1),
    compilerUnit: z.string().min(1),
    path: StoredFilePathSchema,
    language: LanguageSchema,
    frameworks: z.array(FrameworkSchema),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    lines: z.number().int().nonnegative(),
    imports: z.array(ImportRecordSchema),
    exports: z.array(ExportRecordSchema),
    symbolIds: z.array(z.string().min(1)),
    env: z.array(z.string()),
    operations: z.array(ExternalOperationSchema),
    syntax: SyntaxSummarySchema,
  })
  .strict();
export type FileRecord = z.infer<typeof FileRecordSchema>;

export const CompilerUnitRecordSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["configured", "fallback"]),
    root: StoredPathSchema,
    config: StoredFilePathSchema.optional(),
    references: z.array(StoredFilePathSchema),
    extends: z.array(StoredFilePathSchema),
    pathAliases: z.record(StoredModuleAliasSchema, z.array(StoredPathSchema)),
  })
  .strict();
export type CompilerUnitRecord = z.infer<typeof CompilerUnitRecordSchema>;

export const SymbolKindSchema = z.enum([
  "function",
  "class",
  "method",
  "interface",
  "type-alias",
  "variable",
  "react-component",
  "react-hook",
  "react-context",
  "next-page",
  "next-layout",
  "next-route-handler",
  "next-special-file",
  "nest-module",
  "nest-controller",
  "nest-provider",
  "nest-guard",
  "nest-interceptor",
  "nest-pipe",
  "nest-filter",
  "nest-gateway",
  "dto",
  "route",
]);
export type SymbolKind = z.infer<typeof SymbolKindSchema>;

export const SymbolRecordSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: z.string().min(1),
    name: z.string(),
    kind: SymbolKindSchema,
    file: StoredFilePathSchema,
    range: SourceRangeSchema,
    exported: z.boolean(),
    defaultExport: z.boolean().optional(),
    signature: z.string().optional(),
    documentation: z.string().optional(),
    facts: z.record(z.string(), JsonValueSchema),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type SymbolRecord = z.infer<typeof SymbolRecordSchema>;

export const RelationTypeSchema = z.enum([
  "imports",
  "exports",
  "reexports",
  "calls",
  "instantiates",
  "renders",
  "uses-hook",
  "reads-state",
  "depends-on",
  "used-by",
  "contains",
  "references",
  "injects",
  "handles-route",
  "consumes-dto",
  "belongs-to-module",
  "uses-layout",
]);
export type RelationType = z.infer<typeof RelationTypeSchema>;

export const RelationEvidenceClassificationSchema = z.enum([
  "exact",
  "framework-derived",
  "heuristic",
  "derived",
]);
export type RelationEvidenceClassification = z.infer<typeof RelationEvidenceClassificationSchema>;

export const RelationOriginSchema = z
  .object({
    file: StoredFilePathSchema,
    line: z.number().int().positive(),
    range: SourceRangeSchema,
    explanation: z.string().min(1),
    classification: RelationEvidenceClassificationSchema,
    analyzer: z.string().min(1),
  })
  .strict();
export type RelationOrigin = z.infer<typeof RelationOriginSchema>;

export const RelationRecordSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    from: z.string().min(1),
    type: RelationTypeSchema,
    to: z.string().min(1),
    confidence: z.number().min(0).max(1),
    origin: RelationOriginSchema,
  })
  .strict();
export type RelationRecord = z.infer<typeof RelationRecordSchema>;

export const DiagnosticSeveritySchema = z.enum(["info", "warning", "error"]);
export type DiagnosticSeverity = z.infer<typeof DiagnosticSeveritySchema>;

export const DiagnosticCodeSchema = z.enum([
  "parse-error",
  "unresolved-import",
  "invalid-config",
  "unsupported-file",
  "analysis-error",
  "parser-fallback",
  "compiler-config",
]);
export type DiagnosticCode = z.infer<typeof DiagnosticCodeSchema>;

export const DiagnosticRecordSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    code: DiagnosticCodeSchema,
    severity: DiagnosticSeveritySchema,
    message: z.string().min(1),
    file: StoredFilePathSchema.optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
  })
  .strict();
export type DiagnosticRecord = z.infer<typeof DiagnosticRecordSchema>;

export const WorkspacePackageSchema = z
  .object({
    name: z.string(),
    path: StoredFilePathSchema,
    entryPoints: z.array(StoredFilePathSchema),
  })
  .strict();
export type WorkspacePackage = z.infer<typeof WorkspacePackageSchema>;

export const MapCountsSchema = z
  .object({
    files: z.number().int().nonnegative(),
    symbols: z.number().int().nonnegative(),
    relations: z.number().int().nonnegative(),
    diagnostics: z.number().int().nonnegative(),
  })
  .strict();
export type MapCounts = z.infer<typeof MapCountsSchema>;

export const ProjectRecordSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    name: z.string(),
    packageManager: z.string().optional(),
    frameworks: z.array(FrameworkSchema),
    compilerUnits: z.array(CompilerUnitRecordSchema),
    tsconfig: StoredFilePathSchema.optional(),
    pathAliases: z.record(StoredModuleAliasSchema, z.array(StoredPathSchema)),
    entryPoints: z.array(StoredFilePathSchema),
    workspaces: z.array(WorkspacePackageSchema),
    counts: MapCountsSchema,
  })
  .strict();
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

export const ManifestSourceFileSchema = z
  .object({
    path: StoredFilePathSchema,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    compilerUnit: z.string().min(1),
    lines: z.number().int().nonnegative(),
  })
  .strict();
export type ManifestSourceFile = z.infer<typeof ManifestSourceFileSchema>;

const SemanticFileInputRecordSchema = z
  .object({
    path: StoredPathSchema,
    kind: z.literal("file"),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const SemanticResolutionProbeRecordSchema = z
  .object({
    path: StoredPathSchema,
    kind: z.literal("resolution-probe"),
    scope: z.enum(["project", "toolchain"]),
    targetKind: z.enum(["file", "directory", "readable-file"]),
    exists: z.boolean(),
  })
  .strict();
const SemanticDirectoryListingRecordSchema = z
  .object({
    path: StoredPathSchema,
    kind: z.literal("directory-listing"),
    scope: z.enum(["project", "toolchain"]),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const SemanticSymlinkRecordSchema = z
  .object({
    path: StoredPathSchema,
    kind: z.literal("symlink"),
    scope: z.enum(["project", "toolchain"]),
    target: StoredPathSchema,
  })
  .strict();
const SemanticToolchainFileRecordSchema = z
  .object({
    path: StoredPathSchema,
    kind: z.literal("toolchain-file"),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const SemanticInputRecordSchema = z.discriminatedUnion("kind", [
  SemanticFileInputRecordSchema,
  SemanticResolutionProbeRecordSchema,
  SemanticDirectoryListingRecordSchema,
  SemanticSymlinkRecordSchema,
  SemanticToolchainFileRecordSchema,
]);
export type SemanticInputRecord = z.infer<typeof SemanticInputRecordSchema>;

export const ArtifactIntegrityRecordSchema = z
  .object({
    path: z.enum(MAP_COMPANION_ARTIFACTS),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ArtifactIntegrityRecord = z.infer<typeof ArtifactIntegrityRecordSchema>;

export const ProducerRecordSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["built-in", "custom"]),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ProducerRecord = z.infer<typeof ProducerRecordSchema>;

const VersionedToolSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
  })
  .strict();

export const ManifestRecordSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    analyzerVersion: z.string().min(1),
    producer: ProducerRecordSchema,
    semanticResolver: VersionedToolSchema,
    syntaxParser: VersionedToolSchema,
    analyzers: z.array(VersionedToolSchema),
    configHash: z.string().regex(/^[a-f0-9]{64}$/),
    sourceFiles: z.array(ManifestSourceFileSchema),
    semanticInputs: z.array(SemanticInputRecordSchema),
    artifacts: z.array(ArtifactIntegrityRecordSchema),
    integrityHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ManifestRecord = z.infer<typeof ManifestRecordSchema>;

const CodeMapShapeSchema = z
  .object({
    manifest: ManifestRecordSchema,
    project: ProjectRecordSchema,
    files: z.array(FileRecordSchema),
    symbols: z.array(SymbolRecordSchema),
    relations: z.array(RelationRecordSchema),
    diagnostics: z.array(DiagnosticRecordSchema),
  })
  .strict();
export const CodeMapSchema = CodeMapShapeSchema.superRefine((map, context) => {
  const fileByPath = new Map(map.files.map((file) => [file.path, file]));
  const fileIds = new Set<string>();
  const filePaths = new Set<string>();
  const compilerUnitsById = new Map(map.project.compilerUnits.map((unit) => [unit.id, unit]));
  const compilerUnitIds = new Set<string>();
  let fallbackCount = 0;
  for (const [index, file] of map.files.entries()) {
    addDuplicateIssue(context, fileIds, file.id, ["files", index, "id"]);
    addDuplicateIssue(context, filePaths, file.path, ["files", index, "path"]);
    if (file.id !== `file:${file.path}`) {
      context.addIssue({
        code: "custom",
        path: ["files", index, "id"],
        message: "file ID must be derived from its path",
      });
    }
  }

  for (const [index, unit] of map.project.compilerUnits.entries()) {
    addDuplicateIssue(context, compilerUnitIds, unit.id, ["project", "compilerUnits", index, "id"]);
    if (unit.kind === "configured" && !unit.config) {
      context.addIssue({
        code: "custom",
        path: ["project", "compilerUnits", index, "config"],
        message: "configured compiler units require config",
      });
    }
    if (unit.kind === "fallback" && unit.config) {
      context.addIssue({
        code: "custom",
        path: ["project", "compilerUnits", index, "config"],
        message: "fallback compiler units must not have config",
      });
    }
    if (unit.kind === "fallback") {
      fallbackCount += 1;
      if (
        unit.id !== "compiler-unit:generated:fallback" ||
        unit.root !== "." ||
        unit.references.length > 0 ||
        unit.extends.length > 0 ||
        Object.keys(unit.pathAliases).length > 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["project", "compilerUnits", index],
          message: "fallback compiler unit must use the canonical generated identity and shape",
        });
      }
    }
    if (unit.kind === "configured" && unit.config) {
      if (unit.id !== `compiler-unit:configured:${unit.config}`) {
        context.addIssue({
          code: "custom",
          path: ["project", "compilerUnits", index, "id"],
          message: "configured compiler-unit ID must be derived from its config path",
        });
      }
      if (unit.root !== normalizeStoredPath(path.posix.dirname(unit.config))) {
        context.addIssue({
          code: "custom",
          path: ["project", "compilerUnits", index, "root"],
          message: "configured compiler-unit root must match its config directory",
        });
      }
    }
  }
  if (fallbackCount !== 1) {
    context.addIssue({
      code: "custom",
      path: ["project", "compilerUnits"],
      message: "exactly one fallback compiler unit is required",
    });
  }
  const configuredPaths = new Set(
    map.project.compilerUnits.flatMap((unit) =>
      unit.kind === "configured" && unit.config ? [unit.config] : [],
    ),
  );
  if (map.project.tsconfig && !configuredPaths.has(map.project.tsconfig)) {
    context.addIssue({
      code: "custom",
      path: ["project", "tsconfig"],
      message: "project tsconfig must resolve to a configured compiler unit",
    });
  }
  const compatibilityUnit = map.project.tsconfig
    ? map.project.compilerUnits.find((unit) => unit.config === map.project.tsconfig)
    : map.project.compilerUnits
        .filter((unit) => unit.kind === "configured")
        .sort((left, right) => compareText(left.id, right.id))[0];
  if (stableJson(map.project.pathAliases) !== stableJson(compatibilityUnit?.pathAliases ?? {})) {
    context.addIssue({
      code: "custom",
      path: ["project", "pathAliases"],
      message: "project path aliases must match the compatibility compiler unit",
    });
  }
  for (const [index, unit] of map.project.compilerUnits.entries()) {
    for (const reference of unit.references) {
      if (!configuredPaths.has(reference)) {
        context.addIssue({
          code: "custom",
          path: ["project", "compilerUnits", index, "references"],
          message: "compiler-unit reference must resolve to a configured unit",
        });
      }
    }
  }

  const symbolById = new Map<string, (typeof map.symbols)[number]>();
  for (const [index, symbol] of map.symbols.entries()) {
    if (symbolById.has(symbol.id)) {
      context.addIssue({
        code: "custom",
        path: ["symbols", index, "id"],
        message: `duplicate symbol ID ${symbol.id}`,
      });
    }
    symbolById.set(symbol.id, symbol);
    const owner = fileByPath.get(symbol.file);
    if (!owner) {
      context.addIssue({
        code: "custom",
        path: ["symbols", index, "file"],
        message: "symbol references a missing file",
      });
    } else if (owner.hash !== symbol.sourceHash) {
      context.addIssue({
        code: "custom",
        path: ["symbols", index, "sourceHash"],
        message: "symbol source hash does not match its file",
      });
    } else if (!rangeFitsFile(symbol.range, owner)) {
      context.addIssue({
        code: "custom",
        path: ["symbols", index, "range"],
        message: "symbol range must fit within its source file",
      });
    }
  }

  const importRelationKeys = new Set(
    map.relations
      .filter((relation) => relation.type === "imports")
      .map(
        (relation) =>
          `${relation.from}\u0000${relation.to}\u0000${relation.origin.file}\u0000${relation.origin.line}`,
      ),
  );
  const expectedImportRelationKeys = new Set<string>();

  for (const [fileIndex, file] of map.files.entries()) {
    const unit = compilerUnitsById.get(file.compilerUnit);
    if (!unit) {
      context.addIssue({
        code: "custom",
        path: ["files", fileIndex, "compilerUnit"],
        message: "file compiler unit must resolve to exactly one compiler unit",
      });
    }

    const expected = map.symbols
      .filter((symbol) => symbol.file === file.path)
      .map((symbol) => symbol.id)
      .sort();
    const actual = [...file.symbolIds].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      context.addIssue({
        code: "custom",
        path: ["files", fileIndex, "symbolIds"],
        message: "file symbol IDs must exactly match symbols owned by the file",
      });
    }

    for (const [importIndex, importRecord] of file.imports.entries()) {
      if (importRecord.line > file.lines) {
        context.addIssue({
          code: "custom",
          path: ["files", fileIndex, "imports", importIndex, "line"],
          message: "import line must fit within its source file",
        });
      }
      if (importRecord.external && importRecord.resolved) {
        context.addIssue({
          code: "custom",
          path: ["files", fileIndex, "imports", importIndex],
          message: "external imports must not name an internal resolved path",
        });
      }
      if (importRecord.resolved && !fileByPath.has(importRecord.resolved)) {
        context.addIssue({
          code: "custom",
          path: ["files", fileIndex, "imports", importIndex, "resolved"],
          message: "resolved import must reference a persisted file",
        });
      }
      const target = importRecord.resolved
        ? `file:${importRecord.resolved}`
        : `external:${importRecord.source}#default`;
      const key = `${file.id}\u0000${target}\u0000${file.path}\u0000${importRecord.line}`;
      expectedImportRelationKeys.add(key);
      if (!importRelationKeys.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["files", fileIndex, "imports", importIndex],
          message: "import record must have matching relation evidence",
        });
      }
    }
    for (const [exportIndex, exportRecord] of file.exports.entries()) {
      if (exportRecord.line > file.lines) {
        context.addIssue({
          code: "custom",
          path: ["files", fileIndex, "exports", exportIndex, "line"],
          message: "export line must fit within its source file",
        });
      }
    }
    for (const [operationIndex, operation] of file.operations.entries()) {
      if (operation.line > file.lines) {
        context.addIssue({
          code: "custom",
          path: ["files", fileIndex, "operations", operationIndex, "line"],
          message: "operation line must fit within its source file",
        });
      }
    }
  }

  const manifestPaths = new Set<string>();
  for (const [index, source] of map.manifest.sourceFiles.entries()) {
    addDuplicateIssue(context, manifestPaths, source.path, [
      "manifest",
      "sourceFiles",
      index,
      "path",
    ]);
    const file = fileByPath.get(source.path);
    if (!file || file.hash !== source.hash) {
      context.addIssue({
        code: "custom",
        path: ["manifest", "sourceFiles", index],
        message: "manifest source must match a persisted file and hash",
      });
    } else if (file.compilerUnit !== source.compilerUnit) {
      context.addIssue({
        code: "custom",
        path: ["manifest", "sourceFiles", index, "compilerUnit"],
        message: "manifest source ownership must match the persisted file compiler unit",
      });
    } else if (file.lines !== source.lines) {
      context.addIssue({
        code: "custom",
        path: ["manifest", "sourceFiles", index, "lines"],
        message: "manifest source line count must match the persisted file",
      });
    }
  }
  if (manifestPaths.size !== fileByPath.size) {
    context.addIssue({
      code: "custom",
      path: ["manifest", "sourceFiles"],
      message: "manifest sources must exactly cover persisted files",
    });
  }

  const semanticInputIdentities = new Set<string>();
  for (const [index, input] of map.manifest.semanticInputs.entries()) {
    addDuplicateIssue(context, semanticInputIdentities, semanticInputIdentity(input), [
      "manifest",
      "semanticInputs",
      index,
    ]);
  }

  const artifactPaths = new Set<string>();
  for (const [index, artifact] of map.manifest.artifacts.entries()) {
    addDuplicateIssue(context, artifactPaths, artifact.path, [
      "manifest",
      "artifacts",
      index,
      "path",
    ]);
  }
  const expectedArtifacts = [...MAP_COMPANION_ARTIFACTS].sort();
  if (JSON.stringify([...artifactPaths].sort()) !== JSON.stringify(expectedArtifacts)) {
    context.addIssue({
      code: "custom",
      path: ["manifest", "artifacts"],
      message: "manifest artifact hashes must exactly cover every companion artifact",
    });
  }

  const counts = {
    files: map.files.length,
    symbols: map.symbols.length,
    relations: map.relations.length,
    diagnostics: map.diagnostics.length,
  };
  for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
    if (map.project.counts[key] !== counts[key]) {
      context.addIssue({
        code: "custom",
        path: ["project", "counts", key],
        message: `${key} count does not match persisted records`,
      });
    }
  }

  const validEndpoints = new Set([...fileIds, ...symbolById.keys()]);
  const relationIdentities = new Set<string>();
  for (const [index, relation] of map.relations.entries()) {
    addDuplicateIssue(context, relationIdentities, relationIdentity(relation), [
      "relations",
      index,
    ]);
    if (relation.type === "imports") {
      const key = `${relation.from}\u0000${relation.to}\u0000${relation.origin.file}\u0000${relation.origin.line}`;
      if (!expectedImportRelationKeys.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["relations", index],
          message: "imports relation must have a matching file import record",
        });
      }
    }
    for (const endpoint of [relation.from, relation.to]) {
      if (
        !validEndpoints.has(endpoint) &&
        !endpoint.startsWith("external:") &&
        !endpoint.startsWith("route:")
      ) {
        context.addIssue({
          code: "custom",
          path: ["relations", index],
          message: `relation references missing endpoint ${endpoint}`,
        });
      }
    }
    const originFile = fileByPath.get(relation.origin.file);
    if (!originFile) {
      context.addIssue({
        code: "custom",
        path: ["relations", index, "origin", "file"],
        message: "relation evidence references a missing file",
      });
    } else {
      if (relation.origin.line !== relation.origin.range.startLine) {
        context.addIssue({
          code: "custom",
          path: ["relations", index, "origin", "line"],
          message: "relation origin line must match the start of its evidence range",
        });
      }
      if (!rangeFitsFile(relation.origin.range, originFile)) {
        context.addIssue({
          code: "custom",
          path: ["relations", index, "origin", "range"],
          message: "relation evidence range must fit within its source file",
        });
      }
      if (relation.type === "contains" || relation.type === "exports") {
        const fromFile = endpointSourceFile(relation.from, fileByPath, symbolById);
        const toFile = endpointSourceFile(relation.to, fileByPath, symbolById);
        if (
          fromFile !== relation.origin.file ||
          (relation.type === "exports" && toFile !== relation.origin.file)
        ) {
          context.addIssue({
            code: "custom",
            path: ["relations", index],
            message:
              relation.type === "exports"
                ? "exports endpoints and evidence must belong to the same file"
                : "contains evidence must belong to its source endpoint file",
          });
        }

        const fromIsFile = relation.from.startsWith("file:");
        const toSymbol = symbolById.get(relation.to);
        const fromSymbol = symbolById.get(relation.from);
        if (relation.type === "contains" && fromIsFile) {
          if (
            !toSymbol ||
            toSymbol.file !== relation.origin.file ||
            !rangesEqual(toSymbol.range, relation.origin.range)
          ) {
            context.addIssue({
              code: "custom",
              path: ["relations", index],
              message: "file containment evidence must exactly identify a symbol owned by the file",
            });
          }
        } else if (relation.type === "contains" && fromSymbol) {
          if (!toSymbol || !rangeContains(fromSymbol.range, relation.origin.range)) {
            context.addIssue({
              code: "custom",
              path: ["relations", index, "origin", "range"],
              message:
                "symbol containment must target a symbol and its evidence must fall within the source symbol",
            });
          }
        }
        if (
          relation.type === "exports" &&
          (!fromIsFile ||
            !toSymbol ||
            !toSymbol.exported ||
            !rangesEqual(toSymbol.range, relation.origin.range))
        ) {
          context.addIssue({
            code: "custom",
            path: ["relations", index],
            message: "exports evidence must exactly identify an exported symbol owned by the file",
          });
        }
      }
    }
  }

  for (const [index, diagnostic] of map.diagnostics.entries()) {
    const file = diagnostic.file ? fileByPath.get(diagnostic.file) : undefined;
    if (file && diagnostic.line && diagnostic.line > file.lines) {
      context.addIssue({
        code: "custom",
        path: ["diagnostics", index, "line"],
        message: "diagnostic line must fit within its source file",
      });
    }
  }
});
export type CodeMap = z.infer<typeof CodeMapSchema>;

function addDuplicateIssue(
  context: z.RefinementCtx,
  seen: Set<string>,
  value: string,
  path: PropertyKey[],
): void {
  if (seen.has(value)) {
    context.addIssue({ code: "custom", path, message: `duplicate value ${value}` });
  }
  seen.add(value);
}

function relationIdentity(relation: RelationRecord): string {
  const range = relation.origin.range;
  return [
    relation.from,
    relation.type,
    relation.to,
    relation.origin.file,
    range.startLine,
    range.startColumn,
    range.endLine,
    range.endColumn,
  ].join("\u0000");
}

function semanticInputIdentity(input: SemanticInputRecord): string {
  return input.kind === "resolution-probe"
    ? `${input.scope}\u0000${input.path}\u0000${input.kind}\u0000${input.targetKind}`
    : input.kind === "directory-listing" || input.kind === "symlink"
      ? `${input.scope}\u0000${input.path}\u0000${input.kind}`
      : `${input.path}\u0000${input.kind}`;
}

function rangeFitsFile(range: SourceRange, file: FileRecord): boolean {
  return range.startLine <= file.lines && range.endLine <= file.lines;
}

function rangesEqual(left: SourceRange, right: SourceRange): boolean {
  return (
    left.startLine === right.startLine &&
    left.startColumn === right.startColumn &&
    left.endLine === right.endLine &&
    left.endColumn === right.endColumn
  );
}

function rangeContains(outer: SourceRange, inner: SourceRange): boolean {
  const startsAfter =
    inner.startLine > outer.startLine ||
    (inner.startLine === outer.startLine && inner.startColumn >= outer.startColumn);
  const endsBefore =
    inner.endLine < outer.endLine ||
    (inner.endLine === outer.endLine && inner.endColumn <= outer.endColumn);
  return startsAfter && endsBefore;
}

function endpointSourceFile(
  endpoint: string,
  files: ReadonlyMap<string, FileRecord>,
  symbols: ReadonlyMap<string, SymbolRecord>,
): string | undefined {
  if (endpoint.startsWith("file:")) return files.get(endpoint.slice("file:".length))?.path;
  return symbols.get(endpoint)?.file;
}
