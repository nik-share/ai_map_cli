import { z } from "zod";

import {
  CONFIG_VERSION,
  DEFAULT_EXCLUDE,
  DEFAULT_INCLUDE,
  DEFAULT_OUTPUT,
  SCHEMA_VERSION,
} from "./constants.js";

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
      !/^[A-Za-z]:\//.test(value) &&
      !value.split("/").includes(".."),
    "must be a repository-relative POSIX path",
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
    source: z.string().min(1),
    specifiers: z.array(ImportSpecifierRecordSchema),
    resolved: StoredPathSchema.optional(),
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
    source: z.string().optional(),
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
    path: StoredPathSchema,
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
    file: StoredPathSchema,
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
    file: StoredPathSchema,
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
]);
export type DiagnosticCode = z.infer<typeof DiagnosticCodeSchema>;

export const DiagnosticRecordSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    code: DiagnosticCodeSchema,
    severity: DiagnosticSeveritySchema,
    message: z.string().min(1),
    file: StoredPathSchema.optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
  })
  .strict();
export type DiagnosticRecord = z.infer<typeof DiagnosticRecordSchema>;

export const WorkspacePackageSchema = z
  .object({
    name: z.string(),
    path: StoredPathSchema,
    entryPoints: z.array(StoredPathSchema),
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
    tsconfig: StoredPathSchema.optional(),
    pathAliases: z.record(z.string(), z.array(z.string())),
    entryPoints: z.array(StoredPathSchema),
    workspaces: z.array(WorkspacePackageSchema),
    counts: MapCountsSchema,
  })
  .strict();
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

export const ManifestSourceFileSchema = z
  .object({
    path: StoredPathSchema,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ManifestSourceFile = z.infer<typeof ManifestSourceFileSchema>;

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
    semanticResolver: VersionedToolSchema,
    syntaxParser: VersionedToolSchema,
    analyzers: z.array(VersionedToolSchema),
    configHash: z.string().regex(/^[a-f0-9]{64}$/),
    sourceFiles: z.array(ManifestSourceFileSchema),
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
    }
  }

  for (const [fileIndex, file] of map.files.entries()) {
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
    }
  }
  if (manifestPaths.size !== fileByPath.size) {
    context.addIssue({
      code: "custom",
      path: ["manifest", "sourceFiles"],
      message: "manifest sources must exactly cover persisted files",
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
  for (const [index, relation] of map.relations.entries()) {
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
    if (!fileByPath.has(relation.origin.file)) {
      context.addIssue({
        code: "custom",
        path: ["relations", index, "origin", "file"],
        message: "relation evidence references a missing file",
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
