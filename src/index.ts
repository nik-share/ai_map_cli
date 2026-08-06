export { ANALYZER_VERSION, CONFIG_VERSION, SCHEMA_VERSION } from "./constants.js";
export { CodeMapError } from "./errors.js";
export { initProject, createDefaultConfig, findProjectRoot } from "./config.js";
export type { InitOptions, InitResult } from "./config.js";
export { scanProject, createAnalyzer } from "./scan.js";
export { loadCodeMap, buildOverview } from "./storage.js";
export { checkFreshness } from "./freshness.js";
export { showSymbol, formatShowResult } from "./show.js";
export {
  FallbackParserAdapter,
  TypeScriptParserAdapter,
  createTypeScriptParserAdapter,
} from "./parser.js";
export { CoreAnalyzer } from "./analyzers/core.js";
export { ReactAnalyzer } from "./analyzers/react.js";
export { NextJsAnalyzer } from "./analyzers/nextjs.js";
export { NestJsAnalyzer } from "./analyzers/nestjs.js";
export { ManypkgWorkspaceDiscovery, createWorkspaceDiscovery } from "./workspaces.js";
export { GitIgnoreAdapter, createGitIgnoreAdapter } from "./ignore.js";
export { TypeScriptSemanticResolver, createTypeScriptSemanticResolver } from "./semantic.js";
export {
  CodeMapSchema,
  ConfigSchema,
  DiagnosticRecordSchema,
  FileRecordSchema,
  ManifestRecordSchema,
  ProjectRecordSchema,
  RelationRecordSchema,
  SymbolRecordSchema,
} from "./schemas.js";

export type {
  AnalysisContext,
  AnalysisContribution,
  Analyzer,
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
  FrameworkAnalyzer,
  FrameworkSelection,
  FreshnessResult,
  FreshnessStatus,
  IgnoreAdapter,
  ImportRecord,
  ImportSpecifierRecord,
  JsonPrimitive,
  JsonValue,
  Language,
  LoadCodeMapOptions,
  ManifestRecord,
  MapCounts,
  ProjectRecord,
  RelationEvidenceClassification,
  RelationOrigin,
  RelationRecord,
  RelationType,
  ScanChanges,
  ScanOptions,
  ScanResult,
  ShowResult,
  SourceRange,
  SymbolKind,
  SymbolRecord,
  SyntaxFact,
  SyntaxFactKind,
  SyntaxIssue,
  SyntaxParserAdapter,
  SyntaxParseInput,
  SyntaxParseResult,
  SyntaxSummary,
  SemanticResolution,
  SemanticResolveInput,
  SemanticResolver,
  WorkspacePackage,
  WorkspaceDiscovery,
  WorkspaceDiscoveryResult,
} from "./types.js";
