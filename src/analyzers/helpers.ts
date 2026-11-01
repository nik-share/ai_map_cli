import ts from "typescript";

import { SCHEMA_VERSION } from "../constants.js";
import { symbolId } from "../ids.js";
import type {
  AnalysisContext,
  JsonValue,
  SourceRange,
  SymbolKind,
  SymbolRecord,
} from "../types.js";
import { redactAbsolutePathsInText } from "../utils/path.js";

export function nodeRange(sourceFile: ts.SourceFile, node: ts.Node): SourceRange {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

export function nodeLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false)).line + 1;
}

export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return Boolean(
    ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((item) => item.kind === kind),
  );
}

export function hasExportModifier(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

export function hasDefaultModifier(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

export function getDeclarationName(node: ts.Declaration, fallback = "default"): string {
  const name = (node as ts.NamedDeclaration).name;
  if (name && ts.isIdentifier(name)) return name.text;
  if (name && (ts.isStringLiteral(name) || ts.isNumericLiteral(name))) return name.text;
  return fallback;
}

export function getTopLevelDefaultExportDeclaration(
  sourceFile: ts.SourceFile,
): ts.Declaration | undefined {
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      if (ts.isIdentifier(statement.expression)) {
        const defaultName = statement.expression.text;
        const declaration = topLevelDeclarations(sourceFile).find(
          (item) => getDeclarationName(item, "") === defaultName,
        );
        if (declaration) return declaration;
      }
      return statement;
    }

    if (ts.isFunctionDeclaration(statement) && hasDefaultModifier(statement)) return statement;
    if (ts.isClassDeclaration(statement) && hasDefaultModifier(statement)) return statement;
    if (ts.isInterfaceDeclaration(statement) && hasDefaultModifier(statement)) return statement;
    if (ts.isTypeAliasDeclaration(statement) && hasDefaultModifier(statement)) return statement;
    if (ts.isEnumDeclaration(statement) && hasDefaultModifier(statement)) return statement;
    if (ts.isVariableStatement(statement) && hasDefaultModifier(statement)) {
      const declaration = statement.declarationList.declarations.find((item) =>
        ts.isIdentifier(item.name),
      );
      return declaration;
    }
  }
  return undefined;
}

export function hasAnyTopLevelExport(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some(
    (statement) => ts.isExportAssignment(statement) || hasExportModifier(statement),
  );
}

function topLevelDeclarations(sourceFile: ts.SourceFile): ts.Declaration[] {
  return sourceFile.statements.flatMap((statement): ts.Declaration[] => {
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      return [statement];
    }
    if (ts.isVariableStatement(statement)) return [...statement.declarationList.declarations];
    return [];
  });
}

export function getSignature(context: AnalysisContext, node: ts.Node): string | undefined {
  const type = context.checker.getTypeAtLocation(node);
  const signatures = type.getCallSignatures();
  if (signatures.length > 0) {
    return [
      ...new Set(
        signatures.map((signature) =>
          context.checker.signatureToString(
            signature,
            node,
            ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
          ),
        ),
      ),
    ]
      .map(redactStringLiterals)
      .join(" | ");
  }
  if (ts.isClassDeclaration(node)) {
    return compactText(node.getText(context.sourceFile).split(/[\r\n{]/, 1)[0] ?? "");
  }
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
    return compactText(redactStringLiterals(node.getText(context.sourceFile)));
  }
  if (ts.isVariableDeclaration(node) && node.type) {
    return `${getDeclarationName(node)}: ${compactText(node.type.getText(context.sourceFile))}`;
  }
  return undefined;
}

export function redactStringLiterals(value: string): string {
  return value.replace(/(["'])(?:\\.|(?!\1)[^\\\r\n])*\1/g, '"<literal>"');
}

export function makeSymbol(
  context: AnalysisContext,
  node: ts.Declaration | ts.SourceFile,
  kind: SymbolKind,
  options: {
    name?: string;
    parent?: string;
    exported?: boolean;
    defaultExport?: boolean;
    signature?: string;
    facts?: Record<string, JsonValue>;
    documentation?: string;
  } = {},
): SymbolRecord {
  const name = options.name ?? (ts.isSourceFile(node) ? "default" : getDeclarationName(node));
  // Documentation is accepted only from an explicitly configured enricher. The base
  // scanner does not persist arbitrary JSDoc/source prose.
  const documentation = options.documentation;
  const signature =
    options.signature ?? (ts.isSourceFile(node) ? undefined : getSignature(context, node));
  const safeSignature = signature ? redactAbsolutePathsInText(signature, context.root) : undefined;
  const safeDocumentation = documentation
    ? redactAbsolutePathsInText(documentation, context.root)
    : undefined;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: symbolId(kind, context.relativePath, name, options.parent),
    name,
    kind,
    file: context.relativePath,
    range: nodeRange(context.sourceFile, node),
    exported: options.exported ?? (!ts.isSourceFile(node) && hasExportModifier(node)),
    ...((options.defaultExport ?? (!ts.isSourceFile(node) && hasDefaultModifier(node)))
      ? { defaultExport: true }
      : {}),
    ...(safeSignature ? { signature: compactText(safeSignature) } : {}),
    ...(safeDocumentation ? { documentation: compactText(safeDocumentation) } : {}),
    facts: options.facts ?? {},
    sourceHash: context.sourceHash,
  };
}

export function compactText(value: string, maxLength = 500): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

export function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

export function decoratorName(decorator: ts.Decorator): string | undefined {
  const expression = decorator.expression;
  const target = ts.isCallExpression(expression) ? expression.expression : expression;
  return ts.isIdentifier(target) ? target.text : undefined;
}

export function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

export function literalText(expression: ts.Expression | undefined): string | undefined {
  return expression &&
    (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    ? expression.text
    : undefined;
}

export function identifierText(expression: ts.Expression | undefined): string | undefined {
  return expression && ts.isIdentifier(expression) ? expression.text : undefined;
}

export function propertyNameText(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  return undefined;
}
