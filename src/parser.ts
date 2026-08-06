import ts from "typescript";

import type {
  Language,
  SourceRange,
  SyntaxFact,
  SyntaxIssue,
  SyntaxParseInput,
  SyntaxParseResult,
  SyntaxParserAdapter,
} from "./types.js";
import { compareText } from "./utils/stable.js";

export class TypeScriptParserAdapter implements SyntaxParserAdapter {
  readonly name = "typescript-compiler-syntax";
  readonly version = ts.version;

  supports(language: Language): boolean {
    return ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"].includes(language);
  }

  parse(input: SyntaxParseInput): SyntaxParseResult {
    const sourceFile = ts.createSourceFile(
      input.path,
      input.source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(input.language),
    );
    const facts: SyntaxFact[] = [];
    visitSyntax(sourceFile, sourceFile, this.name, facts);
    const parseDiagnostics =
      (sourceFile as unknown as { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] })
        .parseDiagnostics ?? [];
    const issues: SyntaxIssue[] = parseDiagnostics.map((diagnostic) => ({
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      range: offsetRange(sourceFile, diagnostic.start, diagnostic.length),
    }));
    for (const issue of issues) {
      facts.push({
        kind: "parse-error",
        nodeType: "typescript-diagnostic",
        ...(issue.range ? { range: issue.range } : { range: pointRange(1, 1) }),
        evidence: { parser: this.name, exact: true },
      });
    }
    return {
      parser: this.name,
      facts: facts.sort(compareFacts),
      issues,
      hadErrors: issues.length > 0,
    };
  }
}

export class FallbackParserAdapter implements SyntaxParserAdapter {
  readonly name: string;

  constructor(
    readonly primary: SyntaxParserAdapter,
    readonly fallback: SyntaxParserAdapter = new TypeScriptParserAdapter(),
  ) {
    this.name = `${primary.name}-with-${fallback.name}-fallback`;
  }

  async supports(language: Language): Promise<boolean> {
    return (await this.primary.supports(language)) || (await this.fallback.supports(language));
  }

  async parse(input: SyntaxParseInput): Promise<SyntaxParseResult> {
    try {
      if (await this.primary.supports(input.language)) {
        const result = await this.primary.parse(input);
        if (!result.issues.some((issue) => issue.fatal)) return result;
        return await this.parseFallback(
          input,
          `Parser ${this.primary.name} reported a fatal syntax failure.`,
        );
      }
      return await this.parseFallback(
        input,
        `Parser ${this.primary.name} does not support ${input.language}.`,
      );
    } catch {
      // Adapter errors are deliberately not persisted: third-party messages can contain
      // absolute paths, source text, or environment-derived values.
      return this.parseFallback(
        input,
        `Parser ${this.primary.name} failed; used ${this.fallback.name}.`,
      );
    }
  }

  private async parseFallback(input: SyntaxParseInput, reason: string): Promise<SyntaxParseResult> {
    const fallback = await this.fallback.parse(input);
    return {
      ...fallback,
      fallbackFrom: this.primary.name,
      issues: [{ message: reason }, ...fallback.issues],
    };
  }
}

export function createTypeScriptParserAdapter(): SyntaxParserAdapter {
  return new TypeScriptParserAdapter();
}

function visitSyntax(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  parser: string,
  output: SyntaxFact[],
): void {
  const add = (kind: SyntaxFact["kind"], nodeType: string, name?: string): void => {
    output.push({
      kind,
      nodeType,
      ...(name ? { name } : {}),
      range: nodeRange(sourceFile, node),
      evidence: { parser, exact: true },
    });
  };
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    add("import", "import-declaration", node.moduleSpecifier.text);
  } else if (ts.isExportDeclaration(node)) {
    const moduleName =
      node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : undefined;
    add("export", "export-declaration", moduleName ?? exportNames(node));
  } else if (ts.isExportAssignment(node)) {
    add("export", "export-assignment", "default");
  } else if (isNamedDeclarationFact(node)) {
    add("declaration", ts.SyntaxKind[node.kind], declarationName(node));
    if (hasExport(node)) add("export", "export-modifier", declarationName(node));
  } else if (ts.isCallExpression(node)) {
    add("call", "call-expression", expressionName(node.expression));
  } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    add("jsx-element", "jsx-element", node.tagName.getText(sourceFile));
  }
  node.forEachChild((child) => visitSyntax(sourceFile, child, parser, output));
}

function isNamedDeclarationFact(
  node: ts.Node,
): node is
  | ts.FunctionDeclaration
  | ts.ClassDeclaration
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration
  | ts.VariableDeclaration
  | ts.MethodDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isMethodDeclaration(node)
  );
}

function declarationName(node: ts.NamedDeclaration): string | undefined {
  const name = node.name;
  if (!name) return "default";
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  return undefined;
}

function hasExport(node: ts.Node): boolean {
  const owner = ts.isVariableDeclaration(node) ? node.parent.parent : node;
  return Boolean(
    ts.canHaveModifiers(owner) &&
    ts.getModifiers(owner)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function exportNames(node: ts.ExportDeclaration): string | undefined {
  if (!node.exportClause) return "*";
  if (ts.isNamespaceExport(node.exportClause)) return node.exportClause.name.text;
  return node.exportClause.elements
    .map((element) => element.name.text)
    .sort(compareText)
    .join(",");
}

function expressionName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function scriptKind(language: Language): ts.ScriptKind {
  if (language === "tsx") return ts.ScriptKind.TSX;
  if (language === "jsx") return ts.ScriptKind.JSX;
  if (["js", "mjs", "cjs"].includes(language)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function nodeRange(sourceFile: ts.SourceFile, node: ts.Node): SourceRange {
  return offsetRange(
    sourceFile,
    node.getStart(sourceFile, false),
    node.getEnd() - node.getStart(sourceFile, false),
  );
}

function offsetRange(sourceFile: ts.SourceFile, startOffset: number, length: number): SourceRange {
  const start = sourceFile.getLineAndCharacterOfPosition(startOffset);
  const end = sourceFile.getLineAndCharacterOfPosition(startOffset + length);
  return {
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function pointRange(line: number, column: number): SourceRange {
  return { startLine: line, startColumn: column, endLine: line, endColumn: column };
}

function compareFacts(a: SyntaxFact, b: SyntaxFact): number {
  const key = (fact: SyntaxFact) =>
    `${String(fact.range.startLine).padStart(10, "0")}:${String(fact.range.startColumn).padStart(10, "0")}:${fact.kind}:${fact.name ?? ""}`;
  return compareText(key(a), key(b));
}
