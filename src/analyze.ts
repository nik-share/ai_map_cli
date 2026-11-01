import { promises as fs } from "node:fs";
import path from "node:path";

import ts from "typescript";

import { ANALYZER_VERSION, SCHEMA_VERSION } from "./constants.js";
import { fileId, generatedCompilerUnitId } from "./ids.js";
import type {
  AnalysisContext,
  AnalysisContribution,
  CodeMap,
  CompilerUnitRecord,
  DiagnosticRecord,
  FileRecord,
  Framework,
  FrameworkAnalyzer,
  JsonValue,
  ProjectRecord,
  RelationRecord,
  SemanticResolver,
  SemanticInputObservation,
  SemanticInputRecord,
  SymbolRecord,
  SyntaxFact,
  SyntaxParserAdapter,
  SyntaxParseResult,
} from "./types.js";
import {
  DiagnosticRecordSchema,
  FrameworkSchema,
  RelationRecordSchema,
  SymbolRecordSchema,
} from "./schemas.js";
import { hashText } from "./utils/hash.js";
import {
  hasEmbeddedAbsolutePath,
  isAbsolutePath,
  looksLikeHostFilePath,
  normalizeStoredPath,
  redactAbsolutePathsInText,
} from "./utils/path.js";
import { compareText, mapLimit } from "./utils/stable.js";
import { CoreAnalyzer, extractFileStructure } from "./analyzers/core.js";
import { trustedNestJsAnalyzerMethods } from "./analyzers/nestjs.js";
import { trustedNextJsAnalyzerMethods } from "./analyzers/nextjs.js";
import { ReactAnalyzer } from "./analyzers/react.js";
import type { ResolvedConfiguration } from "./config.js";
import { customProducerRecord, defaultProducerRecord, prepareSemanticInputs } from "./freshness.js";
import {
  FallbackParserAdapter,
  isBuiltInTypeScriptParserAdapter,
  TypeScriptParserAdapter,
} from "./parser.js";
import {
  compilerDiagnostic,
  createBoundedModuleResolver,
  TypeScriptSemanticResolver,
} from "./semantic.js";
import type { CompilerUnitPlan } from "./compiler-units.js";
import { runCompilerUnitWorker } from "./compiler-worker-client.js";

interface PreparedSource {
  absolutePath: string;
  relativePath: string;
  content: string;
  hash: string;
  file: FileRecord;
  syntax?: AnalysisContext["syntax"];
}

export interface AnalyzeProjectOptions {
  resolved: ResolvedConfiguration;
  analyzers?: FrameworkAnalyzer[];
  parser?: SyntaxParserAdapter;
  semanticResolver?: SemanticResolver;
}

export async function analyzeProject(options: AnalyzeProjectOptions): Promise<CodeMap> {
  const { resolved } = options;
  const semanticInputs = await prepareSemanticInputs(resolved.root, resolved.config);
  const {
    packageMetadata,
    frameworks: selectedFrameworks,
    discovered,
    compilerGraph,
    configHash,
  } = semanticInputs;
  const parser =
    options.parser && !isBuiltInTypeScriptParserAdapter(options.parser)
      ? new FallbackParserAdapter(options.parser, new TypeScriptParserAdapter())
      : undefined;
  const prepared = await mapLimit(
    discovered,
    resolved.config.concurrency ?? 16,
    async (source): Promise<PreparedSource> => {
      const bytes = await fs.readFile(source.absolutePath);
      const content = bytes.toString("utf8");
      const hash = hashText(bytes);
      const syntax = parser
        ? await parser.parse({
            path: source.relativePath,
            language: source.language,
            source: content,
          })
        : undefined;
      return {
        ...source,
        content,
        hash,
        ...(syntax ? { syntax } : {}),
        file: {
          schemaVersion: SCHEMA_VERSION,
          id: fileId(source.relativePath),
          path: source.relativePath,
          compilerUnit:
            compilerGraph.ownership.get(source.relativePath) ?? generatedCompilerUnitId("fallback"),
          language: source.language,
          frameworks: [],
          hash,
          lines: lineCount(content),
          imports: [],
          exports: [],
          symbolIds: [],
          env: [],
          operations: [],
          syntax: {
            parser: sanitizePersistedText(
              syntax?.parser ?? "typescript-compiler-syntax",
              resolved.root,
            ),
            factCount: syntax?.facts.length ?? 0,
            hadErrors: syntax?.hadErrors ?? false,
            ...(syntax?.fallbackFrom
              ? { fallbackFrom: sanitizePersistedText(syntax.fallbackFrom, resolved.root) }
              : {}),
          },
        },
      };
    },
  );

  const semanticResolver = options.semanticResolver ?? new TypeScriptSemanticResolver();
  const diagnostics: DiagnosticRecord[] = [...compilerGraph.diagnostics];
  for (const source of prepared) {
    const syntax = source.syntax;
    if (!syntax?.fallbackFrom) continue;
    diagnostics.push({
      schemaVersion: SCHEMA_VERSION,
      code: "parser-fallback",
      severity: "warning",
      message:
        syntax.issues[0]?.message ??
        `Parser ${syntax.fallbackFrom} was unavailable; used ${syntax.parser}.`,
      file: source.relativePath,
    });
  }
  const symbols: SymbolRecord[] = [];
  const relations: RelationRecord[] = [];
  const internalPipeline = defaultAnalyzerPipeline();
  const internalAnalyzers = internalPipeline.analyzers;
  const analyzers = uniqueAnalyzers([...internalAnalyzers, ...(options.analyzers ?? [])]);
  const trustedInternalAnalyzers = internalPipeline.methods;
  const preparedByAbsolute = new Map(
    prepared.map((source) => [source.absolutePath, source] as const),
  );
  const indexedSourcePaths = new Set(prepared.map((source) => source.relativePath));
  const unitAliases = new Map<string, Record<string, string[]>>();
  const observedSemanticInputs: SemanticInputObservation[] = [];

  const builtInProducer =
    !options.semanticResolver &&
    !options.analyzers &&
    (!options.parser || isBuiltInTypeScriptParserAdapter(options.parser));

  // A completed worker releases its compiler heap before the next unit or serialization.
  for (const unit of compilerGraph.units) {
    if (unit.ownedFiles.length === 0) continue;
    const unitInput: CompilerWorkerInput = {
      unit,
      root: resolved.root,
      packageDependencies: packageMetadata.dependencies,
      includePrivateSymbols: resolved.config.includePrivateSymbols,
      selectedFrameworks,
      preparedByAbsolute: new Map(
        unit.ownedFiles.flatMap((absolute) => {
          const source = preparedByAbsolute.get(absolute);
          return source ? [[absolute, source] as const] : [];
        }),
      ),
      indexedSourcePaths,
    };
    let contribution: CompilerUnitContribution;
    if (builtInProducer) {
      const result = await runCompilerUnitWorker(unitInput);
      contribution = result.contribution;
      for (const file of result.files) {
        const source = preparedByAbsolute.get(path.resolve(resolved.root, file.path));
        if (source) source.file = file;
      }
    } else {
      contribution = await analyzeCompilerUnit({
        ...unitInput,
        analyzers,
        trustedInternalAnalyzers,
        semanticResolver,
      });
    }
    unitAliases.set(unit.record.id, contribution.pathAliases);
    diagnostics.push(...contribution.diagnostics);
    symbols.push(...contribution.symbols);
    relations.push(...contribution.relations);
    observedSemanticInputs.push(...contribution.semanticInputs);
  }

  const merged = mergeSpecializedSymbols(symbols, relations);
  addFileRelations(prepared, merged.symbols, merged.relations);
  const normalizedRelations = normalizeRelations(
    merged.relations,
    prepared.map((source) => source.file),
    merged.symbols,
    merged.replacements,
    resolved.root,
  );
  for (const source of prepared) {
    source.file.symbolIds = merged.symbols
      .filter((symbol) => symbol.file === source.relativePath)
      .map((symbol) => symbol.id)
      .sort(compareText);
  }

  const compilerUnits = compilerGraph.units.map((unit) => ({
    ...unit.record,
    pathAliases: unitAliases.get(unit.record.id) ?? unit.record.pathAliases,
  }));
  const pathAliases = compatibilityPathAliases(compilerUnits, compilerGraph.primaryConfig);
  const persistedSymbols = merged.symbols.map((symbol) =>
    sanitizePersistedSymbol(symbol, resolved.root),
  );
  const normalizedDiagnostics = normalizeDiagnostics(diagnostics, resolved.root);
  const manifestSemanticInputs = normalizeSemanticInputs(
    observedSemanticInputs,
    new Set(prepared.map((source) => source.relativePath)),
  );
  const producerComponents = {
    semanticResolver: {
      name: sanitizePersistedText(semanticResolver.name, resolved.root),
      version: sanitizePersistedText(semanticResolver.version ?? "unversioned", resolved.root),
    },
    syntaxParser:
      options.parser && !isBuiltInTypeScriptParserAdapter(options.parser)
        ? {
            name: sanitizePersistedText(options.parser.name, resolved.root),
            version: sanitizePersistedText(options.parser.version ?? "unversioned", resolved.root),
          }
        : { name: "typescript-compiler-syntax", version: ts.version },
    analyzers: analyzers
      .map((analyzer) => ({
        name: sanitizePersistedText(analyzer.name, resolved.root),
        version: sanitizePersistedText(analyzer.version ?? "unversioned", resolved.root),
      }))
      .sort((a, b) => compareText(a.name, b.name)),
  };
  const project: ProjectRecord = {
    schemaVersion: SCHEMA_VERSION,
    name: sanitizePersistedText(packageMetadata.name, resolved.root),
    ...(packageMetadata.packageManager
      ? { packageManager: sanitizePersistedText(packageMetadata.packageManager, resolved.root) }
      : {}),
    frameworks: selectedFrameworks,
    ...(compilerGraph.primaryConfig ? { tsconfig: compilerGraph.primaryConfig } : {}),
    pathAliases,
    compilerUnits,
    entryPoints: packageMetadata.entryPoints,
    workspaces: packageMetadata.workspaces.map((workspace) => ({
      ...workspace,
      name: sanitizePersistedText(workspace.name, resolved.root),
    })),
    counts: {
      files: prepared.length,
      symbols: persistedSymbols.length,
      relations: normalizedRelations.length,
      diagnostics: normalizedDiagnostics.length,
    },
  };
  return {
    manifest: {
      schemaVersion: SCHEMA_VERSION,
      analyzerVersion: ANALYZER_VERSION,
      producer: builtInProducer
        ? defaultProducerRecord()
        : customProducerRecord(producerComponents),
      semanticResolver: producerComponents.semanticResolver,
      syntaxParser: producerComponents.syntaxParser,
      analyzers: producerComponents.analyzers,
      configHash,
      sourceFiles: prepared
        .map((source) => ({
          path: source.relativePath,
          hash: source.hash,
          compilerUnit: source.file.compilerUnit,
          lines: source.file.lines,
        }))
        .sort((a, b) => compareText(a.path, b.path)),
      semanticInputs: manifestSemanticInputs,
      artifacts: [],
      integrityHash: "0".repeat(64),
    },
    project,
    files: prepared.map((source) => source.file).sort((a, b) => compareText(a.path, b.path)),
    symbols: persistedSymbols,
    relations: normalizedRelations,
    diagnostics: normalizedDiagnostics,
  };
}

interface AnalyzeCompilerUnitOptions {
  unit: CompilerUnitPlan;
  root: string;
  packageDependencies: AnalysisContext["packageDependencies"];
  includePrivateSymbols: boolean;
  selectedFrameworks: Framework[];
  preparedByAbsolute: Map<string, PreparedSource>;
  indexedSourcePaths: Set<string>;
  analyzers: FrameworkAnalyzer[];
  trustedInternalAnalyzers: ReadonlyMap<FrameworkAnalyzer, TrustedAnalyzerMethods>;
  semanticResolver: SemanticResolver;
}

interface CompilerUnitContribution {
  pathAliases: Record<string, string[]>;
  diagnostics: DiagnosticRecord[];
  symbols: SymbolRecord[];
  relations: RelationRecord[];
  semanticInputs: SemanticInputObservation[];
}

export type CompilerWorkerInput = Omit<
  AnalyzeCompilerUnitOptions,
  "analyzers" | "trustedInternalAnalyzers" | "semanticResolver"
>;

export interface CompilerWorkerResult {
  contribution: CompilerUnitContribution;
  files: FileRecord[];
}

export async function analyzeDefaultCompilerUnit(
  input: CompilerWorkerInput,
): Promise<CompilerWorkerResult> {
  const pipeline = defaultAnalyzerPipeline();
  const contribution = await analyzeCompilerUnit({
    ...input,
    analyzers: pipeline.analyzers,
    trustedInternalAnalyzers: pipeline.methods,
    // We expose type facts and syntactic diagnostics, not TS JSDoc link diagnostics or prose.
    // This mode still parses all JavaScript JSDoc, which can define types.
    semanticResolver: new TypeScriptSemanticResolver(ts.JSDocParsingMode.ParseForTypeInfo),
  });
  return {
    contribution,
    files: [...input.preparedByAbsolute.values()].map((source) => source.file),
  };
}

async function analyzeCompilerUnit(
  options: AnalyzeCompilerUnitOptions,
): Promise<CompilerUnitContribution> {
  const { unit } = options;
  const semantic = await options.semanticResolver.resolve({
    root: options.root,
    sourceFiles: unit.sourceFiles,
    ...(unit.record.config ? { tsconfig: unit.record.config } : {}),
    compilerUnit: unit.record.id,
  });
  const { program, checker } = semantic;
  const resolveModule =
    semantic.resolveModule ??
    createBoundedModuleResolver(
      options.root,
      path.resolve(options.root, unit.record.root),
      program.getCompilerOptions(),
    );
  const diagnostics: DiagnosticRecord[] = [...semantic.diagnostics];
  const symbols: SymbolRecord[] = [];
  const relations: RelationRecord[] = [];

  for (const absolutePath of unit.ownedFiles) {
    const source = options.preparedByAbsolute.get(absolutePath);
    if (!source) continue;
    const sourceFile = program.getSourceFile(source.absolutePath);
    if (!sourceFile) {
      diagnostics.push({
        schemaVersion: SCHEMA_VERSION,
        code: "analysis-error",
        severity: "error",
        message:
          "TypeScript did not include this selected source file in the owning compiler unit.",
        file: source.relativePath,
      });
      continue;
    }
    const sourceDiagnostics = parseDiagnostics(program, sourceFile, options.root);
    diagnostics.push(...sourceDiagnostics);
    const syntax = source.syntax ?? syntaxFromProgram(sourceFile, sourceDiagnostics);
    source.file.syntax = {
      parser: sanitizePersistedText(syntax.parser, options.root),
      factCount: syntax.facts.length,
      hadErrors: syntax.hadErrors,
      ...(syntax.fallbackFrom
        ? { fallbackFrom: sanitizePersistedText(syntax.fallbackFrom, options.root) }
        : {}),
    };
    const context: AnalysisContext = {
      root: options.root,
      relativePath: source.relativePath,
      sourceFile,
      program,
      checker,
      sourceHash: source.hash,
      file: source.file,
      packageDependencies: options.packageDependencies,
      syntax,
      includePrivateSymbols: options.includePrivateSymbols,
      compilerUnit: unit.record,
      indexedSourcePaths: options.indexedSourcePaths,
      resolveModule,
    };

    const structure = extractFileStructure(context);
    source.file.imports = structure.imports;
    source.file.exports = structure.exports;
    source.file.env = structure.env;
    source.file.operations = structure.operations;
    diagnostics.push(...structure.diagnostics);
    relations.push(...structure.relations);

    for (const analyzer of options.analyzers) {
      const trustedSupport = trustedAnalyzerMethods(analyzer, options.trustedInternalAnalyzers);
      let supported = false;
      try {
        supported = trustedSupport
          ? trustedSupport.supports(context)
          : analyzer.supports(isolateCustomAnalyzerContext(context));
      } catch {
        diagnostics.push({
          schemaVersion: SCHEMA_VERSION,
          code: "analysis-error",
          severity: "warning",
          message: `Analyzer ${analyzer.name} failed during capability detection; its contribution was skipped.`,
          file: source.relativePath,
        });
        continue;
      }
      if (!supported || !analyzerEnabled(analyzer, options.selectedFrameworks)) continue;
      try {
        // Re-resolve trust immediately before invocation. A supplied analyzer is never allowed to
        // retain a cached trusted decision and then swap behavior between supports() and analyze().
        const trustedAnalysis = trustedAnalyzerMethods(analyzer, options.trustedInternalAnalyzers);
        const rawContribution = trustedAnalysis
          ? await trustedAnalysis.analyze(context)
          : await analyzer.analyze(isolateCustomAnalyzerContext(context));
        const contribution = trustedAnalysis
          ? rawContribution
          : sanitizeCustomContribution(
              rawContribution,
              options.root,
              analyzer.name,
              source,
              symbols,
            );
        symbols.push(...(contribution.symbols ?? []));
        relations.push(...(contribution.relations ?? []));
        diagnostics.push(...(contribution.diagnostics ?? []));
        source.file.frameworks.push(...(contribution.frameworks ?? []));
      } catch {
        diagnostics.push({
          schemaVersion: SCHEMA_VERSION,
          code: "analysis-error",
          severity: "warning",
          message: `Analyzer ${analyzer.name} failed; its contribution was skipped.`,
          file: source.relativePath,
        });
      }
    }
    source.file.frameworks = [...new Set(source.file.frameworks)].sort();
  }

  return {
    pathAliases: semantic.pathAliases,
    diagnostics,
    symbols,
    relations,
    semanticInputs: semantic.semanticInputs?.() ?? [],
  };
}

function isolateCustomAnalyzerContext(context: AnalysisContext): AnalysisContext {
  return {
    ...context,
    file: structuredClone(context.file),
    syntax: structuredClone(context.syntax),
    compilerUnit: structuredClone(context.compilerUnit),
    packageDependencies: new Set(context.packageDependencies),
    ...(context.indexedSourcePaths
      ? { indexedSourcePaths: new Set(context.indexedSourcePaths) }
      : {}),
  };
}

function sanitizeCustomContribution(
  contribution: AnalysisContribution,
  root: string,
  analyzerName: string,
  source: PreparedSource,
  knownSymbols: SymbolRecord[],
): AnalysisContribution {
  const sourceFileId = fileId(source.relativePath);
  const localSymbolIds = new Set<string>(
    knownSymbols.filter((symbol) => symbol.file === source.relativePath).map((symbol) => symbol.id),
  );
  const localSymbols = new Map<string, SymbolRecord>(
    knownSymbols
      .filter((symbol) => symbol.file === source.relativePath)
      .map((symbol) => [symbol.id, symbol]),
  );

  const symbolIds = new Map<string, string>();
  const warnings: DiagnosticRecord[] = [];
  const pushWarning = (message: string) => {
    warnings.push({
      schemaVersion: SCHEMA_VERSION,
      code: "analysis-error",
      severity: "warning",
      message: sanitizePersistedText(message, root),
      file: source.relativePath,
    });
  };

  const rangeFitsSource = (range: SymbolRecord["range"]): boolean =>
    range.startLine >= 1 &&
    range.endLine >= range.startLine &&
    range.endLine <= source.file.lines &&
    (range.endLine !== range.startLine || range.endColumn >= range.startColumn);
  const sanitizeEndpoint = (value: string): string =>
    symbolIds.get(value) ?? sanitizeCustomIdentifier(value, root);

  const symbols: SymbolRecord[] = [];
  for (const raw of contribution.symbols ?? []) {
    const sanitized = {
      ...raw,
      id: sanitizeCustomIdentifier(raw.id, root),
      name: sanitizePersistedText(raw.name, root),
      ...(raw.signature ? { signature: sanitizePersistedText(raw.signature, root) } : {}),
      ...(raw.documentation
        ? { documentation: sanitizePersistedText(raw.documentation, root) }
        : {}),
      facts: Object.fromEntries(
        Object.entries(raw.facts).map(([key, value]) => [
          sanitizePersistedText(key, root),
          sanitizeJsonValue(value, root),
        ]),
      ),
    };
    const parsed = SymbolRecordSchema.safeParse(sanitized);
    if (!parsed.success) {
      pushWarning(`Analyzer ${analyzerName} emitted an invalid custom symbol.`);
      continue;
    }
    if (parsed.data.file !== source.relativePath) {
      pushWarning(
        `Analyzer ${analyzerName} emitted a custom symbol for non-local file ${parsed.data.file}.`,
      );
      continue;
    }
    if (parsed.data.sourceHash !== source.hash) {
      pushWarning(
        `Analyzer ${analyzerName} emitted a custom symbol with a source hash mismatch for ${parsed.data.id}.`,
      );
      continue;
    }
    if (!rangeFitsSource(parsed.data.range)) {
      pushWarning(
        `Analyzer ${analyzerName} emitted a custom symbol with out-of-bounds source range for ${parsed.data.id}.`,
      );
      continue;
    }
    symbols.push(parsed.data);
    symbolIds.set(raw.id, parsed.data.id);
    localSymbolIds.add(parsed.data.id);
    localSymbols.set(parsed.data.id, parsed.data);
  }

  const relations: RelationRecord[] = [];
  for (const raw of contribution.relations ?? []) {
    const relation = {
      ...raw,
      from: sanitizeEndpoint(raw.from),
      to: sanitizeEndpoint(raw.to),
      origin: {
        ...raw.origin,
        explanation: sanitizePersistedText(raw.origin.explanation, root),
        analyzer: sanitizePersistedText(raw.origin.analyzer, root),
      },
    };
    const parsed = RelationRecordSchema.safeParse(relation);
    if (!parsed.success) {
      pushWarning(
        `Analyzer ${analyzerName} emitted an invalid custom relation from ${relation.from} to ${relation.to}.`,
      );
      continue;
    }
    if (
      parsed.data.origin.file !== source.relativePath ||
      parsed.data.origin.line !== parsed.data.origin.range.startLine ||
      parsed.data.origin.range.startLine < 1 ||
      parsed.data.origin.range.endLine > source.file.lines
    ) {
      pushWarning(
        `Analyzer ${analyzerName} emitted a custom relation with invalid evidence bounds for ${parsed.data.from} -> ${parsed.data.to}.`,
      );
      continue;
    }
    if (parsed.data.type === "imports") {
      pushWarning(
        `Analyzer ${analyzerName} emitted a custom imports relation; imports are core-owned and were skipped.`,
      );
      continue;
    } else if (parsed.data.type === "contains" || parsed.data.type === "exports") {
      const targetSymbol = localSymbols.get(parsed.data.to);
      if (!targetSymbol || !rangesEqual(parsed.data.origin.range, targetSymbol.range)) {
        pushWarning(
          `Analyzer ${analyzerName} emitted an invalid custom structural relation ${parsed.data.type} ${parsed.data.from} -> ${parsed.data.to}.`,
        );
        continue;
      }
      if (parsed.data.type === "exports") {
        if (parsed.data.from !== sourceFileId || !targetSymbol.exported) {
          pushWarning(
            `Analyzer ${analyzerName} emitted an invalid custom export relation ${parsed.data.from} -> ${parsed.data.to}.`,
          );
          continue;
        }
      } else if (parsed.data.from !== sourceFileId) {
        const parentSymbol = localSymbols.get(parsed.data.from);
        if (!parentSymbol || !rangeContains(parentSymbol.range, parsed.data.origin.range)) {
          pushWarning(
            `Analyzer ${analyzerName} emitted an invalid custom containment relation ${parsed.data.from} -> ${parsed.data.to}.`,
          );
          continue;
        }
      } else if (!localSymbolIds.has(parsed.data.to)) {
        pushWarning(
          `Analyzer ${analyzerName} emitted an invalid custom containment relation from file to non-local symbol ${parsed.data.to}.`,
        );
        continue;
      }
    }
    relations.push(parsed.data);
  }

  const diagnostics: DiagnosticRecord[] = [];
  for (const raw of contribution.diagnostics ?? []) {
    const diagnostic = {
      ...raw,
      message: sanitizePersistedText(raw.message, root),
    };
    const parsed = DiagnosticRecordSchema.safeParse(diagnostic);
    if (!parsed.success) {
      pushWarning(`Analyzer ${analyzerName} emitted an invalid custom diagnostic.`);
      continue;
    }
    if (parsed.data.file && parsed.data.file !== source.relativePath) {
      pushWarning(
        `Analyzer ${analyzerName} emitted a custom diagnostic for non-local file ${parsed.data.file}.`,
      );
      continue;
    }
    if (parsed.data.file && parsed.data.line && parsed.data.line > source.file.lines) {
      pushWarning(
        `Analyzer ${analyzerName} emitted a custom diagnostic with out-of-bounds line ${parsed.data.line}.`,
      );
      continue;
    }
    diagnostics.push(parsed.data);
  }

  const frameworks: Framework[] = [];
  for (const rawFramework of contribution.frameworks ?? []) {
    const parsed = FrameworkSchema.safeParse(rawFramework);
    if (!parsed.success) {
      pushWarning(`Analyzer ${analyzerName} emitted an invalid custom framework ${rawFramework}.`);
      continue;
    }
    frameworks.push(parsed.data);
  }
  return {
    ...(symbols.length ? { symbols } : {}),
    ...(relations.length ? { relations } : {}),
    ...(diagnostics.length || warnings.length
      ? {
          diagnostics: [...diagnostics, ...warnings],
        }
      : {}),
    ...(frameworks.length ? { frameworks } : {}),
  };
}

function sanitizeCustomIdentifier(value: string, root: string): string {
  if (value.startsWith("route:")) {
    const route = value.slice("route:".length);
    return looksLikeHostFilePath(route, root) ? "route:<redacted>" : value;
  }
  if (value.startsWith("external:")) {
    const separator = value.lastIndexOf("#");
    const moduleName = value.slice("external:".length, separator > 0 ? separator : undefined);
    const exported = separator > 0 ? value.slice(separator + 1) : "default";
    const safeModule =
      isAbsolutePath(moduleName) || hasEmbeddedAbsolutePath(moduleName)
        ? "<absolute-import>"
        : sanitizePersistedText(moduleName, root);
    return `external:${safeModule}#${sanitizePersistedText(exported, root)}`;
  }
  const prefixEnd = value.indexOf(":");
  const nameStart = value.lastIndexOf("#");
  if (prefixEnd >= 0) {
    const pathEnd = nameStart > prefixEnd ? nameStart : value.length;
    const candidatePath = value.slice(prefixEnd + 1, pathEnd);
    if (isAbsolutePath(candidatePath) || hasEmbeddedAbsolutePath(candidatePath)) {
      const safePath = sanitizePersistedText(candidatePath, root);
      const suffix = nameStart > prefixEnd ? value.slice(nameStart) : "";
      return `${value.slice(0, prefixEnd + 1)}${safePath}${sanitizePersistedText(suffix, root)}`;
    }
  }
  return sanitizePersistedText(value, root);
}

function rangesEqual(left: SymbolRecord["range"], right: SymbolRecord["range"]): boolean {
  return (
    left.startLine === right.startLine &&
    left.startColumn === right.startColumn &&
    left.endLine === right.endLine &&
    left.endColumn === right.endColumn
  );
}

function rangeContains(outer: SymbolRecord["range"], inner: SymbolRecord["range"]): boolean {
  if (
    outer.startLine > inner.startLine ||
    (outer.startLine === inner.startLine && outer.startColumn > inner.startColumn)
  )
    return false;
  if (
    outer.endLine < inner.endLine ||
    (outer.endLine === inner.endLine && outer.endColumn < inner.endColumn)
  )
    return false;
  return true;
}

function sanitizeJsonValue(value: JsonValue, root: string): JsonValue {
  if (typeof value === "string") return sanitizePersistedText(value, root);
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item, root));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        sanitizePersistedText(key, root),
        sanitizeJsonValue(item, root),
      ]),
    );
  }
  return value;
}

export function defaultAnalyzers(): FrameworkAnalyzer[] {
  return [new CoreAnalyzer(), new ReactAnalyzer()];
}

const canonicalCoreAnalyzerMethods: TrustedAnalyzerMethods = {
  supports: CoreAnalyzer.prototype.supports.bind(CoreAnalyzer.prototype),
  analyze: CoreAnalyzer.prototype.analyze.bind(CoreAnalyzer.prototype),
};
const canonicalReactAnalyzerMethods: TrustedAnalyzerMethods = {
  supports: ReactAnalyzer.prototype.supports.bind(ReactAnalyzer.prototype),
  analyze: ReactAnalyzer.prototype.analyze.bind(ReactAnalyzer.prototype),
};

function defaultAnalyzerPipeline(): {
  analyzers: FrameworkAnalyzer[];
  methods: ReadonlyMap<FrameworkAnalyzer, TrustedAnalyzerMethods>;
} {
  const core = new CoreAnalyzer();
  const react = new ReactAnalyzer();
  return {
    analyzers: [core, react],
    methods: new Map<FrameworkAnalyzer, TrustedAnalyzerMethods>([
      [core, canonicalCoreAnalyzerMethods],
      [react, canonicalReactAnalyzerMethods],
    ]),
  };
}

function uniqueAnalyzers(analyzers: FrameworkAnalyzer[]): FrameworkAnalyzer[] {
  const byName = new Map<string, FrameworkAnalyzer>();
  for (const analyzer of analyzers) byName.set(analyzer.name, analyzer);
  return [...byName.values()];
}

function analyzerEnabled(analyzer: FrameworkAnalyzer, frameworks: Framework[]): boolean {
  if (analyzer instanceof CoreAnalyzer) return true;
  const name = analyzer.name.toLowerCase();
  if (name.includes("react")) return frameworks.includes("react") || frameworks.includes("nextjs");
  if (name.includes("next")) return frameworks.includes("nextjs");
  if (name.includes("nest")) return frameworks.includes("nestjs");
  return true;
}

interface TrustedAnalyzerMethods {
  supports(context: AnalysisContext): boolean;
  analyze(context: AnalysisContext): AnalysisContribution | Promise<AnalysisContribution>;
}

function trustedAnalyzerMethods(
  analyzer: FrameworkAnalyzer,
  internal: ReadonlyMap<FrameworkAnalyzer, TrustedAnalyzerMethods>,
): TrustedAnalyzerMethods | undefined {
  const internalMethods = internal.get(analyzer);
  if (internalMethods) return internalMethods;
  return trustedNextJsAnalyzerMethods(analyzer) ?? trustedNestJsAnalyzerMethods(analyzer);
}

function parseDiagnostics(
  program: ts.Program,
  sourceFile: ts.SourceFile,
  root: string,
): DiagnosticRecord[] {
  return program
    .getSyntacticDiagnostics(sourceFile)
    .map((diagnostic) => compilerDiagnostic(diagnostic, root));
}

function syntaxFromProgram(
  sourceFile: ts.SourceFile,
  diagnostics: DiagnosticRecord[],
): SyntaxParseResult {
  const parser = "typescript-compiler-syntax";
  const facts: SyntaxFact[] = [];
  for (const statement of sourceFile.statements) {
    const kind = ts.isImportDeclaration(statement)
      ? "import"
      : ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)
        ? "export"
        : isTopLevelDeclaration(statement)
          ? "declaration"
          : undefined;
    if (!kind) continue;
    const name = syntaxStatementName(statement);
    facts.push({
      kind,
      nodeType: ts.SyntaxKind[statement.kind],
      ...(name ? { name } : {}),
      range: sourceRange(sourceFile, statement),
      evidence: { parser, exact: true },
    });
  }
  for (const diagnostic of diagnostics) {
    facts.push({
      kind: "parse-error",
      nodeType: "typescript-diagnostic",
      range: {
        startLine: diagnostic.line ?? 1,
        startColumn: diagnostic.column ?? 1,
        endLine: diagnostic.line ?? 1,
        endColumn: diagnostic.column ?? 1,
      },
      evidence: { parser, exact: true },
    });
  }
  return {
    parser,
    facts,
    issues: diagnostics.map((diagnostic) => ({ message: diagnostic.message })),
    hadErrors: diagnostics.length > 0,
  };
}

function isTopLevelDeclaration(statement: ts.Statement): boolean {
  return (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isVariableStatement(statement)
  );
}

function syntaxStatementName(statement: ts.Statement): string | undefined {
  if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
    return statement.moduleSpecifier.text;
  }
  if (ts.isExportAssignment(statement)) return "default";
  if (ts.isExportDeclaration(statement)) {
    return statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : "export";
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .map((declaration) => (ts.isIdentifier(declaration.name) ? declaration.name.text : undefined))
      .filter((name): name is string => name !== undefined)
      .join(",");
  }
  const name = (statement as unknown as ts.NamedDeclaration).name;
  return name && ts.isIdentifier(name) ? name.text : undefined;
}

function sourceRange(sourceFile: ts.SourceFile, node: ts.Node): SymbolRecord["range"] {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

interface MergedSymbols {
  symbols: SymbolRecord[];
  relations: RelationRecord[];
  replacements: Map<string, string>;
}

function mergeSpecializedSymbols(
  values: SymbolRecord[],
  relations: RelationRecord[],
): MergedSymbols {
  const byLocation = new Map<string, SymbolRecord>();
  const replacements = new Map<string, string>();
  for (const value of values) {
    const key = `${value.file}:${value.range.startLine}:${value.range.startColumn}:${value.name}`;
    const existing = byLocation.get(key);
    if (!existing) {
      byLocation.set(key, value);
      continue;
    }
    const winner =
      specializationPriority(value.kind) >= specializationPriority(existing.kind)
        ? mergeSymbolFacts(value, existing)
        : mergeSymbolFacts(existing, value);
    const loser = winner.id === value.id ? existing : value;
    replacements.set(loser.id, winner.id);
    byLocation.set(key, winner);
  }
  return {
    symbols: [...byLocation.values()].sort((a, b) => compareText(a.id, b.id)),
    relations,
    replacements,
  };
}

function specializationPriority(kind: SymbolRecord["kind"]): number {
  if (kind.startsWith("nest-") || kind.startsWith("next-") || kind === "route" || kind === "dto")
    return 3;
  if (kind.startsWith("react-")) return 2;
  return 1;
}

function mergeSymbolFacts(primary: SymbolRecord, secondary: SymbolRecord): SymbolRecord {
  return {
    ...primary,
    exported: primary.exported || secondary.exported,
    ...(primary.defaultExport || secondary.defaultExport ? { defaultExport: true } : {}),
    ...((primary.signature ?? secondary.signature)
      ? { signature: primary.signature ?? secondary.signature }
      : {}),
    ...((primary.documentation ?? secondary.documentation)
      ? { documentation: primary.documentation ?? secondary.documentation }
      : {}),
    facts: { ...secondary.facts, ...primary.facts },
  };
}

function addFileRelations(
  prepared: PreparedSource[],
  symbols: SymbolRecord[],
  relations: RelationRecord[],
): void {
  for (const symbol of symbols) {
    const source = prepared.find((candidate) => candidate.relativePath === symbol.file);
    if (!source) continue;
    relations.push({
      schemaVersion: SCHEMA_VERSION,
      from: fileId(symbol.file),
      type: "contains",
      to: symbol.id,
      confidence: 1,
      origin: {
        file: symbol.file,
        line: symbol.range.startLine,
        range: symbol.range,
        explanation: "source containment",
        classification: "exact",
        analyzer: "typescript-node",
      },
    });
    if (symbol.exported) {
      relations.push({
        schemaVersion: SCHEMA_VERSION,
        from: fileId(symbol.file),
        type: "exports",
        to: symbol.id,
        confidence: 1,
        origin: {
          file: symbol.file,
          line: symbol.range.startLine,
          range: symbol.range,
          explanation: "export modifier",
          classification: "exact",
          analyzer: "typescript-node",
        },
      });
    }
  }
}

function normalizeRelations(
  values: RelationRecord[],
  files: FileRecord[],
  symbols: SymbolRecord[],
  replacements: Map<string, string>,
  root: string,
): RelationRecord[] {
  const knownFiles = new Set(files.map((file) => file.id));
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const byFileAndName = new Map<string, SymbolRecord>();
  for (const symbol of symbols) byFileAndName.set(`${symbol.file}#${symbol.name}`, symbol);
  const resolveEndpoint = (id: string): string | undefined => {
    let resolved = id;
    const visited = new Set<string>();
    while (replacements.has(resolved) && !visited.has(resolved)) {
      visited.add(resolved);
      const replacement = replacements.get(resolved);
      if (!replacement) break;
      resolved = replacement;
    }
    if (
      knownFiles.has(resolved) ||
      byId.has(resolved) ||
      resolved.startsWith("external:") ||
      resolved.startsWith("route:")
    )
      return resolved;
    const parsed = /^(?:[^:]+):(.+)#([^#.]+)$/.exec(resolved);
    if (parsed) return byFileAndName.get(`${parsed[1]}#${parsed[2]}`)?.id;
    return undefined;
  };

  const all: RelationRecord[] = [];
  for (const value of values) {
    const from = resolveEndpoint(value.from);
    const to = resolveEndpoint(value.to);
    if (!from || !to || from === to) continue;
    all.push({
      ...value,
      from,
      to,
      confidence: clampConfidence(value.confidence),
      origin: {
        ...value.origin,
        explanation: sanitizePersistedText(value.origin.explanation, root),
        analyzer: sanitizePersistedText(value.origin.analyzer, root),
      },
    });
  }
  for (const value of [...all]) {
    if (!inverseEligible(value.type)) continue;
    all.push({
      ...value,
      from: value.to,
      type: "used-by",
      to: value.from,
      origin: {
        ...value.origin,
        explanation: `inverse of ${value.type}`,
        classification: "derived",
        analyzer: "relation-normalizer",
      },
    });
  }
  const map = new Map<string, RelationRecord>();
  for (const value of all) {
    const key = `${value.from}\u0000${value.type}\u0000${value.to}\u0000${value.origin.file}\u0000${value.origin.range.startLine}\u0000${value.origin.range.startColumn}\u0000${value.origin.range.endLine}\u0000${value.origin.range.endColumn}`;
    const existing = map.get(key);
    if (!existing || relationWouldReplace(existing, value)) map.set(key, value);
  }
  return [...map.values()].sort((a, b) => compareText(relationKey(a), relationKey(b)));
}

function relationWouldReplace(existing: RelationRecord, candidate: RelationRecord): boolean {
  if (candidate.confidence > existing.confidence) return true;
  if (candidate.confidence < existing.confidence) return false;
  const candidateRank = relationDeterministicRank(candidate);
  const existingRank = relationDeterministicRank(existing);
  if (candidateRank !== existingRank) return candidateRank > existingRank;
  return compareText(relationKey(candidate), relationKey(existing)) < 0;
}

function relationDeterministicRank(relation: RelationRecord): number {
  switch (relation.origin.classification) {
    case "exact":
      return 2;
    case "derived":
      return 1;
    case "framework-derived":
    default:
      return 0;
  }
}

function inverseEligible(type: RelationRecord["type"]): boolean {
  return ["calls", "instantiates", "renders", "uses-hook", "depends-on", "injects"].includes(type);
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function relationKey(value: RelationRecord): string {
  return [
    value.from,
    value.type,
    value.to,
    value.origin.file,
    String(value.origin.range.startLine).padStart(10, "0"),
    String(value.origin.range.startColumn).padStart(10, "0"),
    String(value.origin.range.endLine).padStart(10, "0"),
    String(value.origin.range.endColumn).padStart(10, "0"),
    value.origin.classification,
    value.origin.analyzer,
    value.origin.explanation,
  ].join("\u0000");
}

function normalizeDiagnostics(values: DiagnosticRecord[], root: string): DiagnosticRecord[] {
  const map = new Map<string, DiagnosticRecord>();
  for (const value of values) {
    const sanitized = { ...value, message: sanitizePersistedText(value.message, root) };
    const key = `${sanitized.file ?? ""}:${sanitized.line ?? 0}:${sanitized.column ?? 0}:${sanitized.code}:${sanitized.message}`;
    map.set(key, sanitized);
  }
  return [...map.values()].sort((a, b) => compareText(diagnosticKey(a), diagnosticKey(b)));
}

function sanitizePersistedSymbol(symbol: SymbolRecord, root: string): SymbolRecord {
  return {
    ...symbol,
    ...(symbol.signature ? { signature: sanitizePersistedText(symbol.signature, root) } : {}),
    ...(symbol.documentation
      ? { documentation: sanitizePersistedText(symbol.documentation, root) }
      : {}),
  };
}

function sanitizePersistedText(value: string, root: string): string {
  return redactAbsolutePathsInText(value, root) || "<redacted>";
}

function diagnosticKey(value: DiagnosticRecord): string {
  return `${value.file ?? ""}\u0000${String(value.line ?? 0).padStart(10, "0")}\u0000${value.code}\u0000${value.message}`;
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r\n|\r|\n/).length;
}

function normalizeSemanticInputs(
  values: SemanticInputObservation[],
  indexedSources: ReadonlySet<string>,
): SemanticInputRecord[] {
  const byIdentity = new Map<string, SemanticInputRecord>();
  for (const value of values) {
    const normalized = normalizeStoredPath(value.path);
    if (!isSafeSemanticInputPath(normalized)) continue;
    if (value.kind === "file" && indexedSources.has(normalized)) continue;
    if (value.kind === "symlink") {
      const target = normalizeStoredPath(value.target);
      if (!isSafeSemanticInputPath(target)) continue;
      const record: SemanticInputRecord = {
        ...value,
        path: normalized,
        scope: value.scope ?? "project",
        target,
      };
      byIdentity.set(semanticInputIdentity(record), record);
      continue;
    }
    const record: SemanticInputRecord =
      value.kind === "resolution-probe" || value.kind === "directory-listing"
        ? { ...value, path: normalized, scope: value.scope ?? "project" }
        : { ...value, path: normalized };
    byIdentity.set(semanticInputIdentity(record), record);
  }
  for (const value of byIdentity.values()) {
    if (value.kind === "file") {
      byIdentity.delete(`resolution-probe\u0000project\u0000file\u0000${value.path}`);
      byIdentity.delete(`resolution-probe\u0000project\u0000readable-file\u0000${value.path}`);
    } else if (value.kind === "toolchain-file") {
      byIdentity.delete(`resolution-probe\u0000toolchain\u0000file\u0000${value.path}`);
      byIdentity.delete(`resolution-probe\u0000toolchain\u0000readable-file\u0000${value.path}`);
    } else if (value.kind === "directory-listing") {
      byIdentity.delete(`resolution-probe\u0000${value.scope}\u0000directory\u0000${value.path}`);
    }
  }
  return [...byIdentity.values()].sort((a, b) =>
    compareText(semanticInputIdentity(a), semanticInputIdentity(b)),
  );
}

function semanticInputIdentity(value: SemanticInputRecord): string {
  return value.kind === "resolution-probe"
    ? `${value.kind}\u0000${value.scope}\u0000${value.targetKind}\u0000${value.path}`
    : value.kind === "directory-listing" || value.kind === "symlink"
      ? `${value.kind}\u0000${value.scope}\u0000${value.path}`
      : `${value.kind}\u0000${value.path}`;
}

function isSafeSemanticInputPath(value: string): boolean {
  return !isAbsolutePath(value) && value !== ".." && !value.startsWith("../");
}

function compatibilityPathAliases(
  units: CompilerUnitRecord[],
  primaryConfig: string | undefined,
): Record<string, string[]> {
  const primary = primaryConfig
    ? units.find((unit) => unit.config === primaryConfig)
    : units.find((unit) => unit.kind === "configured");
  return primary?.pathAliases ?? {};
}
