import { promises as fs } from "node:fs";

import ts from "typescript";

import { ANALYZER_VERSION, SCHEMA_VERSION } from "./constants.js";
import { discoverSourceFiles, locateTsconfig, readPackageMetadata } from "./discovery.js";
import { fileId } from "./ids.js";
import type {
  AnalysisContext,
  CodeMap,
  DiagnosticRecord,
  FileRecord,
  Framework,
  FrameworkAnalyzer,
  ProjectRecord,
  RelationRecord,
  SemanticResolver,
  SymbolRecord,
  SyntaxFact,
  SyntaxParserAdapter,
  SyntaxParseResult,
} from "./types.js";
import { hashText } from "./utils/hash.js";
import { compareText, mapLimit } from "./utils/stable.js";
import { CoreAnalyzer, extractFileStructure } from "./analyzers/core.js";
import { ReactAnalyzer } from "./analyzers/react.js";
import type { ResolvedConfiguration } from "./config.js";
import { effectiveFrameworks } from "./config.js";
import { computeAnalysisConfigHash } from "./freshness.js";
import { FallbackParserAdapter, TypeScriptParserAdapter } from "./parser.js";
import { compilerDiagnostic, TypeScriptSemanticResolver } from "./semantic.js";

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
  const packageMetadata = await readPackageMetadata(resolved.root);
  const selectedFrameworks = effectiveFrameworks(
    resolved.config.frameworks,
    packageMetadata.frameworks,
  );
  const discovered = await discoverSourceFiles(resolved.root, resolved.config);
  const parser =
    options.parser && !(options.parser instanceof TypeScriptParserAdapter)
      ? new FallbackParserAdapter(options.parser, new TypeScriptParserAdapter())
      : undefined;
  const prepared = await mapLimit(
    discovered,
    resolved.config.concurrency ?? 16,
    async (source): Promise<PreparedSource> => {
      const content = await fs.readFile(source.absolutePath, "utf8");
      const hash = hashText(content);
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
            parser: syntax?.parser ?? "typescript-compiler-syntax",
            factCount: syntax?.facts.length ?? 0,
            hadErrors: syntax?.hadErrors ?? false,
            ...(syntax?.fallbackFrom ? { fallbackFrom: syntax.fallbackFrom } : {}),
          },
        },
      };
    },
  );

  const tsconfig = await locateTsconfig(resolved.root, resolved.config.tsconfig);
  const semanticResolver = options.semanticResolver ?? new TypeScriptSemanticResolver();
  const semantic = await semanticResolver.resolve({
    root: resolved.root,
    sourceFiles: prepared.map((source) => source.absolutePath),
    ...(tsconfig ? { tsconfig } : {}),
  });
  const { program, checker } = semantic;
  const diagnostics: DiagnosticRecord[] = [...semantic.diagnostics];
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
  const analyzers = uniqueAnalyzers([...defaultAnalyzers(), ...(options.analyzers ?? [])]);

  for (const source of prepared) {
    const sourceFile = program.getSourceFile(source.absolutePath);
    if (!sourceFile) {
      diagnostics.push({
        schemaVersion: SCHEMA_VERSION,
        code: "analysis-error",
        severity: "error",
        message: "TypeScript did not include this selected source file in the analysis program.",
        file: source.relativePath,
      });
      continue;
    }
    const sourceDiagnostics = parseDiagnostics(program, sourceFile, resolved.root);
    diagnostics.push(...sourceDiagnostics);
    const syntax = source.syntax ?? syntaxFromProgram(sourceFile, sourceDiagnostics);
    source.file.syntax = {
      parser: syntax.parser,
      factCount: syntax.facts.length,
      hadErrors: syntax.hadErrors,
      ...(syntax.fallbackFrom ? { fallbackFrom: syntax.fallbackFrom } : {}),
    };
    const context: AnalysisContext = {
      root: resolved.root,
      relativePath: source.relativePath,
      sourceFile,
      program,
      checker,
      sourceHash: source.hash,
      file: source.file,
      packageDependencies: packageMetadata.dependencies,
      syntax,
      includePrivateSymbols: resolved.config.includePrivateSymbols,
    };

    const structure = extractFileStructure(context);
    source.file.imports = structure.imports;
    source.file.exports = structure.exports;
    source.file.env = structure.env;
    source.file.operations = structure.operations;
    diagnostics.push(...structure.diagnostics);
    relations.push(...structure.relations);

    for (const analyzer of analyzers) {
      if (!analyzer.supports(context) || !analyzerEnabled(analyzer, selectedFrameworks)) continue;
      try {
        const contribution = await analyzer.analyze(context);
        const contributedSymbols = contribution.symbols ?? [];
        symbols.push(...contributedSymbols);
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

  const merged = mergeSpecializedSymbols(symbols, relations);
  addFileRelations(prepared, merged.symbols, merged.relations);
  const normalizedRelations = normalizeRelations(
    merged.relations,
    prepared.map((source) => source.file),
    merged.symbols,
    merged.replacements,
  );
  for (const source of prepared) {
    source.file.symbolIds = merged.symbols
      .filter((symbol) => symbol.file === source.relativePath)
      .map((symbol) => symbol.id)
      .sort(compareText);
  }

  const pathAliases = semantic.pathAliases;
  const normalizedDiagnostics = normalizeDiagnostics(diagnostics);
  const project: ProjectRecord = {
    schemaVersion: SCHEMA_VERSION,
    name: packageMetadata.name,
    ...(packageMetadata.packageManager ? { packageManager: packageMetadata.packageManager } : {}),
    frameworks: selectedFrameworks,
    ...(tsconfig ? { tsconfig } : {}),
    pathAliases,
    entryPoints: packageMetadata.entryPoints,
    workspaces: packageMetadata.workspaces,
    counts: {
      files: prepared.length,
      symbols: merged.symbols.length,
      relations: normalizedRelations.length,
      diagnostics: normalizedDiagnostics.length,
    },
  };
  const configHash = await computeAnalysisConfigHash(
    resolved.root,
    resolved.config,
    selectedFrameworks,
    packageMetadata.raw,
    packageMetadata.workspaces,
  );
  return {
    manifest: {
      schemaVersion: SCHEMA_VERSION,
      analyzerVersion: ANALYZER_VERSION,
      semanticResolver: {
        name: semanticResolver.name,
        version: semanticResolver.version ?? "unversioned",
      },
      syntaxParser:
        options.parser && !(options.parser instanceof TypeScriptParserAdapter)
          ? { name: options.parser.name, version: options.parser.version ?? "unversioned" }
          : { name: "typescript-compiler-syntax", version: ts.version },
      analyzers: analyzers
        .map((analyzer) => ({ name: analyzer.name, version: analyzer.version ?? "unversioned" }))
        .sort((a, b) => compareText(a.name, b.name)),
      configHash,
      sourceFiles: prepared
        .map((source) => ({ path: source.relativePath, hash: source.hash }))
        .sort((a, b) => compareText(a.path, b.path)),
    },
    project,
    files: prepared.map((source) => source.file).sort((a, b) => compareText(a.path, b.path)),
    symbols: merged.symbols,
    relations: normalizedRelations,
    diagnostics: normalizedDiagnostics,
  };
}

export function defaultAnalyzers(): FrameworkAnalyzer[] {
  return [new CoreAnalyzer(), new ReactAnalyzer()];
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
    all.push({ ...value, from, to, confidence: clampConfidence(value.confidence) });
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
    const key = `${value.from}\u0000${value.type}\u0000${value.to}\u0000${value.origin.file}\u0000${value.origin.line}`;
    const existing = map.get(key);
    if (!existing || value.confidence > existing.confidence) map.set(key, value);
  }
  return [...map.values()].sort((a, b) => compareText(relationKey(a), relationKey(b)));
}

function inverseEligible(type: RelationRecord["type"]): boolean {
  return ["calls", "instantiates", "renders", "uses-hook", "depends-on", "injects"].includes(type);
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function relationKey(value: RelationRecord): string {
  return `${value.from}\u0000${value.type}\u0000${value.to}\u0000${value.origin.file}\u0000${String(value.origin.line).padStart(10, "0")}`;
}

function normalizeDiagnostics(values: DiagnosticRecord[]): DiagnosticRecord[] {
  const map = new Map<string, DiagnosticRecord>();
  for (const value of values) {
    const key = `${value.file ?? ""}:${value.line ?? 0}:${value.column ?? 0}:${value.code}:${value.message}`;
    map.set(key, value);
  }
  return [...map.values()].sort((a, b) => compareText(diagnosticKey(a), diagnosticKey(b)));
}

function diagnosticKey(value: DiagnosticRecord): string {
  return `${value.file ?? ""}\u0000${String(value.line ?? 0).padStart(10, "0")}\u0000${value.code}\u0000${value.message}`;
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r\n|\r|\n/).length;
}
