import path from "node:path";

import ts from "typescript";

import { SCHEMA_VERSION } from "./constants.js";
import type {
  DiagnosticRecord,
  SemanticResolution,
  SemanticResolveInput,
  SemanticResolver,
} from "./types.js";
import { normalizeStoredPath, relativePosix } from "./utils/path.js";
import { compareText } from "./utils/stable.js";

/** TypeScript remains authoritative for all TypeScript/JavaScript semantic facts. */
export class TypeScriptSemanticResolver implements SemanticResolver {
  readonly name = "typescript-program";
  readonly version = ts.version;

  resolve(input: SemanticResolveInput): SemanticResolution {
    const compiler = loadCompilerConfiguration(input.root, input.tsconfig);
    const program = ts.createProgram({
      rootNames: [...input.sourceFiles],
      options: compiler.options,
    });
    return {
      program,
      checker: program.getTypeChecker(),
      pathAliases: compiler.pathAliases,
      diagnostics: compiler.diagnostics,
    };
  }
}

export function createTypeScriptSemanticResolver(): SemanticResolver {
  return new TypeScriptSemanticResolver();
}

interface CompilerConfiguration {
  options: ts.CompilerOptions;
  pathAliases: Record<string, string[]>;
  diagnostics: DiagnosticRecord[];
}

function loadCompilerConfiguration(root: string, tsconfig?: string): CompilerConfiguration {
  const defaults: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    jsx: ts.JsxEmit.Preserve,
    experimentalDecorators: true,
  };
  if (!tsconfig) return { options: defaults, pathAliases: {}, diagnostics: [] };

  const absolute = path.resolve(root, tsconfig);
  const read = ts.readConfigFile(absolute, (fileName) => ts.sys.readFile(fileName));
  if (read.error) {
    return {
      options: defaults,
      pathAliases: {},
      diagnostics: [compilerDiagnostic(read.error, root)],
    };
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(absolute));
  const paths = parsed.options.paths ?? {};
  const pathAliases = Object.fromEntries(
    Object.entries(paths)
      .sort(([a], [b]) => compareText(a, b))
      .map(([alias, values]) => [alias, [...values].map(normalizeStoredPath).sort(compareText)]),
  );
  return {
    options: {
      ...defaults,
      ...parsed.options,
      allowJs: true,
      checkJs: parsed.options.checkJs ?? false,
      noEmit: true,
      skipLibCheck: true,
    },
    pathAliases,
    diagnostics: parsed.errors.map((diagnostic) => compilerDiagnostic(diagnostic, root)),
  };
}

export function compilerDiagnostic(diagnostic: ts.Diagnostic, root: string): DiagnosticRecord {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const file = diagnostic.file;
  const start =
    file && diagnostic.start !== undefined
      ? file.getLineAndCharacterOfPosition(diagnostic.start)
      : undefined;
  let relativeFile: string | undefined;
  if (file) {
    try {
      relativeFile = relativePosix(root, file.fileName);
    } catch {
      // Never persist absolute or out-of-root compiler paths.
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    code: "parse-error",
    severity: "error",
    message,
    ...(relativeFile ? { file: relativeFile } : {}),
    ...(start ? { line: start.line + 1, column: start.character + 1 } : {}),
  };
}
