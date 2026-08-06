import { performance } from "node:perf_hooks";

import { analyzeProject, defaultAnalyzers } from "./analyze.js";
import { initProject, resolveConfiguration } from "./config.js";
import { CodeMapError } from "./errors.js";
import { compareSources } from "./freshness.js";
import { loadCodeMapFrom, writeCodeMap } from "./storage.js";
import type {
  CodeMap,
  FrameworkAnalyzer,
  ScanOptions,
  ScanResult,
  SyntaxParserAdapter,
} from "./types.js";
import { FallbackParserAdapter, TypeScriptParserAdapter } from "./parser.js";

export async function scanProject(options: ScanOptions = {}): Promise<ScanResult> {
  const started = performance.now();
  let resolved = await resolveConfiguration(options);
  let wroteConfig = false;
  if (!resolved.configExists) {
    const initialized = await initProject({
      ...(options.root ? { root: options.root } : {}),
      ...(options.config ? { config: options.config } : {}),
      ...(options.output ? { output: options.output } : {}),
    });
    wroteConfig = initialized.created;
    resolved = await resolveConfiguration(options);
  }

  let previous: CodeMap | undefined;
  try {
    previous = await loadCodeMapFrom(resolved.outputDir);
  } catch (error) {
    if (
      !(error instanceof CodeMapError) ||
      !["MAP_NOT_FOUND", "INCOMPATIBLE_SCHEMA", "INVALID_MAP"].includes(error.code)
    ) {
      throw error;
    }
  }
  const map = await analyzeProject({
    resolved,
    ...(options.analyzers ? { analyzers: options.analyzers } : {}),
    ...(options.parser ? { parser: options.parser } : {}),
    ...(options.semanticResolver ? { semanticResolver: options.semanticResolver } : {}),
  });
  const changes = compareSources(previous?.manifest.sourceFiles ?? [], map.manifest.sourceFiles);
  const wroteMap = await writeCodeMap(resolved, map);
  const criticalParseErrors = map.diagnostics.some(
    (diagnostic) => diagnostic.code === "parse-error" && diagnostic.severity === "error",
  );
  return {
    map,
    root: resolved.root,
    outputDir: resolved.outputDir,
    wrote: wroteConfig || wroteMap,
    changes,
    elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    counts: map.project.counts,
    criticalParseErrors,
  };
}

export function createAnalyzer(
  options: {
    analyzers?: FrameworkAnalyzer[];
    parser?: SyntaxParserAdapter;
    semanticResolver?: import("./types.js").SemanticResolver;
  } = {},
) {
  const analyzers = [...defaultAnalyzers(), ...(options.analyzers ?? [])];
  const parser = options.parser
    ? new FallbackParserAdapter(options.parser, new TypeScriptParserAdapter())
    : new TypeScriptParserAdapter();
  return {
    analyzers,
    parser,
    scan: (scanOptions: ScanOptions = {}) =>
      scanProject({
        ...scanOptions,
        ...(options.analyzers && !scanOptions.analyzers ? { analyzers: options.analyzers } : {}),
        ...(options.parser && !scanOptions.parser ? { parser: options.parser } : {}),
        ...(options.semanticResolver && !scanOptions.semanticResolver
          ? { semanticResolver: options.semanticResolver }
          : {}),
      }),
  };
}
