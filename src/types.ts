import type ts from "typescript";

import type {
  CodeMap,
  DiagnosticRecord,
  FileRecord,
  Framework,
  Language,
  MapCounts,
  RelationRecord,
  SourceRange,
  SymbolRecord,
  WorkspacePackage,
} from "./schemas.js";

export type {
  CodeMap,
  CodeMapConfig,
  DiagnosticCode,
  DiagnosticRecord,
  DiagnosticSeverity,
  ExportRecord,
  ExternalOperation,
  ExternalOperationKind,
  FileRecord,
  Framework,
  FrameworkSelection,
  ImportRecord,
  ImportSpecifierRecord,
  JsonPrimitive,
  JsonValue,
  Language,
  ManifestRecord,
  ManifestSourceFile,
  MapCounts,
  ProjectRecord,
  RelationEvidenceClassification,
  RelationOrigin,
  RelationRecord,
  RelationType,
  SourceRange,
  SymbolKind,
  SymbolRecord,
  SyntaxSummary,
  WorkspacePackage,
} from "./schemas.js";

export type SyntaxFactKind =
  "import" | "export" | "declaration" | "call" | "jsx-element" | "parse-error";

export interface SyntaxFact {
  kind: SyntaxFactKind;
  name?: string;
  nodeType: string;
  range: SourceRange;
  evidence: {
    parser: string;
    exact: boolean;
  };
}

export interface SyntaxIssue {
  message: string;
  range?: SourceRange;
  fatal?: boolean;
}

export interface SyntaxParseInput {
  path: string;
  language: Language;
  source: string;
}

export interface SyntaxParseResult {
  parser: string;
  facts: SyntaxFact[];
  issues: SyntaxIssue[];
  hadErrors: boolean;
  fallbackFrom?: string;
}

export interface SyntaxParserAdapter {
  readonly name: string;
  readonly version?: string;
  supports(language: Language): boolean | Promise<boolean>;
  parse(input: SyntaxParseInput): SyntaxParseResult | Promise<SyntaxParseResult>;
}

export interface WorkspaceDiscoveryResult {
  tool: string;
  packages: WorkspacePackage[];
}

export interface WorkspaceDiscovery {
  readonly name: string;
  discover(root: string): Promise<WorkspaceDiscoveryResult>;
}

export interface IgnoreAdapter {
  readonly name: string;
  filter(root: string, paths: readonly string[]): Promise<string[]>;
}

export interface SemanticResolveInput {
  root: string;
  sourceFiles: string[];
  tsconfig?: string;
}

export interface SemanticResolution {
  program: ts.Program;
  checker: ts.TypeChecker;
  pathAliases: Record<string, string[]>;
  diagnostics: DiagnosticRecord[];
}

export interface SemanticResolver {
  readonly name: string;
  readonly version?: string;
  resolve(input: SemanticResolveInput): SemanticResolution | Promise<SemanticResolution>;
}

export interface ScanOptions {
  root?: string;
  config?: string;
  output?: string;
  strict?: boolean;
  analyzers?: FrameworkAnalyzer[];
  parser?: SyntaxParserAdapter;
  semanticResolver?: SemanticResolver;
}

export interface ScanChanges {
  added: string[];
  modified: string[];
  deleted: string[];
  moved: Array<{ from: string; to: string }>;
}

export interface ScanResult {
  map: CodeMap;
  root: string;
  outputDir: string;
  wrote: boolean;
  changes: ScanChanges;
  elapsedMs: number;
  counts: MapCounts;
  criticalParseErrors: boolean;
}

export interface LoadCodeMapOptions {
  root?: string;
  config?: string;
  output?: string;
}

export type FreshnessStatus = "current" | "stale" | "missing";
export interface FreshnessResult {
  status: FreshnessStatus;
  current: boolean;
  root: string;
  outputDir: string;
  reasons: string[];
  changes: ScanChanges;
}

export interface ShowResult {
  selector: string;
  matches: Array<{
    symbol: SymbolRecord;
    file: FileRecord;
    inbound: RelationRecord[];
    outbound: RelationRecord[];
  }>;
}

export interface AnalysisContext {
  root: string;
  relativePath: string;
  sourceFile: ts.SourceFile;
  program: ts.Program;
  checker: ts.TypeChecker;
  sourceHash: string;
  file: FileRecord;
  packageDependencies: Set<string>;
  syntax: SyntaxParseResult;
  includePrivateSymbols: boolean;
}

export interface AnalysisContribution {
  symbols?: SymbolRecord[];
  relations?: RelationRecord[];
  diagnostics?: DiagnosticRecord[];
  frameworks?: Framework[];
}

export interface FrameworkAnalyzer {
  readonly name: string;
  readonly version?: string;
  supports(context: AnalysisContext): boolean;
  analyze(context: AnalysisContext): AnalysisContribution | Promise<AnalysisContribution>;
}

export interface Analyzer {
  readonly analyzers: readonly FrameworkAnalyzer[];
  readonly parser: SyntaxParserAdapter;
  scan(options?: ScanOptions): Promise<ScanResult>;
}
