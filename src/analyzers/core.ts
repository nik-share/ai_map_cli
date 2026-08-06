import { isBuiltin } from "node:module";
import path from "node:path";

import ts from "typescript";

import { SCHEMA_VERSION } from "../constants.js";
import { externalId, fileId, symbolId } from "../ids.js";
import type {
  AnalysisContext,
  AnalysisContribution,
  DiagnosticRecord,
  ExportRecord,
  ExternalOperation,
  FileRecord,
  FrameworkAnalyzer,
  ImportRecord,
  RelationRecord,
  SymbolKind,
  SymbolRecord,
} from "../types.js";
import { isPathInside, relativePosix } from "../utils/path.js";
import { compareText } from "../utils/stable.js";
import {
  getDeclarationName,
  hasDefaultModifier,
  hasExportModifier,
  hasModifier,
  makeSymbol,
  nodeLine,
  nodeRange,
  propertyNameText,
  visit,
} from "./helpers.js";

export class CoreAnalyzer implements FrameworkAnalyzer {
  readonly name = "typescript-node";
  readonly version = "0.1.0";

  supports(): boolean {
    return true;
  }

  analyze(context: AnalysisContext): AnalysisContribution {
    const symbols: SymbolRecord[] = [];
    const relations: RelationRecord[] = [];
    const seenSymbols = new Map<string, SymbolRecord>();

    for (const statement of context.sourceFile.statements) {
      extractTopLevelSymbol(context, statement, seenSymbols, relations);
    }
    symbols.push(...seenSymbols.values());

    const declarationIds = declarationIdMap(context, symbols);
    collectBehaviorRelations(context, declarationIds, relations);

    return {
      symbols: symbols.sort((a, b) => compareText(a.id, b.id)),
      relations,
      frameworks: ["typescript", "node"],
    };
  }
}

function extractTopLevelSymbol(
  context: AnalysisContext,
  statement: ts.Statement,
  output: Map<string, SymbolRecord>,
  relations: RelationRecord[],
): void {
  if (ts.isFunctionDeclaration(statement)) {
    const name = statement.name?.text ?? "default";
    const record = makeSymbol(context, statement, "function", {
      name,
      exported: isNameExported(context, name, statement),
      facts: { async: hasModifier(statement, ts.SyntaxKind.AsyncKeyword) },
    });
    keepBestDeclaration(output, record, Boolean(statement.body));
    return;
  }
  if (ts.isClassDeclaration(statement)) {
    const className = statement.name?.text ?? "default";
    const classRecord = makeSymbol(context, statement, "class", {
      name: className,
      exported: isNameExported(context, className, statement),
    });
    keepBestDeclaration(output, classRecord, true);
    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) && !ts.isConstructorDeclaration(member)) continue;
      if (hasModifier(member, ts.SyntaxKind.PrivateKeyword) && !isPrivateEnabled(context)) {
        continue;
      }
      const name = ts.isConstructorDeclaration(member)
        ? "constructor"
        : (propertyNameText(member.name) ?? "anonymous");
      const method = makeSymbol(context, member, "method", {
        name,
        parent: className,
        exported: classRecord.exported,
        facts: {
          async: ts.isMethodDeclaration(member)
            ? hasModifier(member, ts.SyntaxKind.AsyncKeyword)
            : false,
        },
      });
      keepBestDeclaration(output, method, Boolean(member.body));
      relations.push(
        relation(classRecord.id, "contains", method.id, context, member, 1, "class member"),
      );
    }
    return;
  }
  if (ts.isInterfaceDeclaration(statement)) {
    keepBestDeclaration(
      output,
      makeSymbol(context, statement, "interface", {
        exported: isNameExported(context, statement.name.text, statement),
      }),
      true,
    );
    return;
  }
  if (ts.isTypeAliasDeclaration(statement)) {
    keepBestDeclaration(
      output,
      makeSymbol(context, statement, "type-alias", {
        exported: isNameExported(context, statement.name.text, statement),
      }),
      true,
    );
    return;
  }
  if (ts.isVariableStatement(statement)) {
    const defaultExport = hasDefaultModifier(statement);
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const functionLike =
        declaration.initializer !== undefined &&
        (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer));
      const record = makeSymbol(context, declaration, functionLike ? "function" : "variable", {
        exported: isNameExported(context, declaration.name.text, statement),
        defaultExport,
        facts: functionLike
          ? { async: hasModifier(declaration.initializer, ts.SyntaxKind.AsyncKeyword) }
          : {},
      });
      keepBestDeclaration(output, record, true);
    }
  }
}

function isNameExported(context: AnalysisContext, name: string, node: ts.Node): boolean {
  if (hasExportModifier(node) || hasDefaultModifier(node)) return true;
  return context.file.exports.some(
    (entry) => !entry.source && (entry.local === name || (!entry.local && entry.name === name)),
  );
}

function isPrivateEnabled(context: AnalysisContext): boolean {
  return context.includePrivateSymbols;
}

function keepBestDeclaration(
  output: Map<string, SymbolRecord>,
  record: SymbolRecord,
  hasImplementation: boolean,
): void {
  const existing = output.get(record.id);
  if (!existing || hasImplementation || !existing.signature) output.set(record.id, record);
}

function declarationIdMap(
  context: AnalysisContext,
  symbols: SymbolRecord[],
): Map<ts.Declaration, string> {
  const byKey = new Map(symbols.map((symbol) => [`${symbol.kind}:${symbol.name}`, symbol.id]));
  const result = new Map<ts.Declaration, string>();
  for (const statement of context.sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text ?? "default";
      const id = byKey.get(`function:${name}`);
      if (id) result.set(statement, id);
    } else if (ts.isClassDeclaration(statement)) {
      const name = statement.name?.text ?? "default";
      const id = byKey.get(`class:${name}`);
      if (id) result.set(statement, id);
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) && !ts.isConstructorDeclaration(member)) continue;
        const memberName = ts.isConstructorDeclaration(member)
          ? "constructor"
          : (propertyNameText(member.name) ?? "anonymous");
        const memberId = symbolId("method", context.relativePath, memberName, name);
        result.set(member, memberId);
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const kind =
          declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer))
            ? "function"
            : "variable";
        const id = byKey.get(`${kind}:${declaration.name.text}`);
        if (id) result.set(declaration, id);
      }
    } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      const kind = ts.isInterfaceDeclaration(statement) ? "interface" : "type-alias";
      const id = byKey.get(`${kind}:${statement.name.text}`);
      if (id) result.set(statement, id);
    }
  }
  return result;
}

function collectBehaviorRelations(
  context: AnalysisContext,
  declarationIds: Map<ts.Declaration, string>,
  output: RelationRecord[],
): void {
  let currentOwner = fileId(context.relativePath);
  const walk = (node: ts.Node): void => {
    const previousOwner = currentOwner;
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node)
    ) {
      currentOwner = declarationIds.get(node) ?? currentOwner;
    } else if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      ts.isVariableDeclaration(node.parent)
    ) {
      currentOwner = declarationIds.get(node.parent) ?? currentOwner;
    } else if (ts.isClassDeclaration(node)) {
      currentOwner = declarationIds.get(node) ?? currentOwner;
    }

    if (ts.isCallExpression(node) && !isRequireCall(node)) {
      const target = resolveExpressionTarget(context, node.expression);
      if (target && target.id !== currentOwner) {
        output.push(
          relation(
            currentOwner,
            "calls",
            target.id,
            context,
            node,
            target.exact ? 1 : 0.35,
            target.exact ? "TypeScript symbol resolution" : "unresolved call syntax",
          ),
        );
      }
    } else if (ts.isNewExpression(node)) {
      const target = resolveExpressionTarget(context, node.expression);
      if (target && target.id !== currentOwner) {
        output.push(
          relation(
            currentOwner,
            "instantiates",
            target.id,
            context,
            node,
            target.exact ? 1 : 0.35,
            target.exact ? "TypeScript constructor resolution" : "unresolved constructor syntax",
          ),
        );
      }
    }

    if (ts.isIdentifier(node) && isReferenceIdentifier(node)) {
      const target = resolveExpressionTarget(context, node, false);
      if (target?.exact && target.id !== currentOwner && !target.id.startsWith("external:")) {
        output.push(
          relation(
            currentOwner,
            "references",
            target.id,
            context,
            node,
            1,
            "TypeScript symbol reference",
          ),
        );
      }
    }

    node.forEachChild(walk);
    currentOwner = previousOwner;
  };
  walk(context.sourceFile);

  for (const statement of context.sourceFile.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    const from = declarationIds.get(statement);
    if (!from) continue;
    for (const clause of statement.heritageClauses ?? []) {
      for (const type of clause.types) {
        const target = resolveExpressionTarget(context, type.expression);
        if (target) {
          output.push(
            relation(
              from,
              "depends-on",
              target.id,
              context,
              type,
              target.exact ? 1 : 0.35,
              target.exact ? "TypeScript heritage resolution" : "unresolved heritage syntax",
            ),
          );
        }
      }
    }
  }
}

interface TargetResolution {
  id: string;
  exact: boolean;
}

function resolveExpressionTarget(
  context: AnalysisContext,
  expression: ts.Expression,
  allowFallback = true,
): TargetResolution | undefined {
  let symbol = context.checker.getSymbolAtLocation(expression);
  if (!symbol && ts.isPropertyAccessExpression(expression)) {
    symbol = context.checker.getSymbolAtLocation(expression.name);
  }
  if (!symbol) {
    const imported = resolveImportedExpressionTarget(context, expression);
    if (imported) return { id: imported, exact: true };
    const fallback = allowFallback ? expressionFallbackId(expression) : undefined;
    return fallback ? { id: fallback, exact: false } : undefined;
  }
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      symbol = context.checker.getAliasedSymbol(symbol);
    } catch {
      // An unresolved alias still gets an external fallback below.
    }
  }
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) {
    const imported = resolveImportedExpressionTarget(context, expression);
    if (imported) return { id: imported, exact: true };
    const fallback = allowFallback ? expressionFallbackId(expression) : undefined;
    return fallback ? { id: fallback, exact: false } : undefined;
  }
  const source = declaration.getSourceFile();
  if (!isPathInside(context.root, source.fileName)) {
    return { id: externalId(inferExternalModule(expression), symbol.getName()), exact: true };
  }
  const relative = relativePosix(context.root, source.fileName);
  const id = declarationToId(declaration, relative);
  return id ? { id, exact: true } : undefined;
}

function resolveImportedExpressionTarget(
  context: AnalysisContext,
  expression: ts.Expression,
): string | undefined {
  if (!ts.isIdentifier(expression)) return undefined;
  for (const imported of context.file.imports) {
    if (!imported.resolved) continue;
    const specifier = imported.specifiers.find((item) => item.local === expression.text);
    if (!specifier) continue;
    const sourceFile = context.program.getSourceFile(path.resolve(context.root, imported.resolved));
    if (!sourceFile) continue;
    const declaration = findExportedDeclaration(sourceFile, specifier.imported);
    if (declaration) return declarationToId(declaration, imported.resolved);
  }
  return undefined;
}

function findExportedDeclaration(
  sourceFile: ts.SourceFile,
  exportedName: string,
): ts.Declaration | undefined {
  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      ((exportedName === "default" && hasDefaultModifier(statement)) ||
        statement.name?.text === exportedName)
    ) {
      return statement;
    }
    if (ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations.find(
        (item) => ts.isIdentifier(item.name) && item.name.text === exportedName,
      );
      if (declaration) return declaration;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      const specifier = statement.exportClause.elements.find(
        (item) => item.name.text === exportedName,
      );
      if (specifier && !statement.moduleSpecifier) {
        return findExportedDeclaration(
          sourceFile,
          specifier.propertyName?.text ?? specifier.name.text,
        );
      }
    }
  }
  return undefined;
}

function declarationToId(declaration: ts.Declaration, filePath: string): string | undefined {
  if (ts.isFunctionDeclaration(declaration)) {
    return symbolId("function", filePath, declaration.name?.text ?? "default");
  }
  if (ts.isClassDeclaration(declaration)) {
    return symbolId("class", filePath, declaration.name?.text ?? "default");
  }
  if (ts.isMethodDeclaration(declaration)) {
    const parent = declaration.parent;
    const parentName =
      ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent)
        ? (parent.name?.text ?? "default")
        : "anonymous";
    return symbolId(
      "method",
      filePath,
      propertyNameText(declaration.name) ?? "anonymous",
      parentName,
    );
  }
  if (ts.isVariableDeclaration(declaration)) {
    const name = getDeclarationName(declaration);
    const kind: SymbolKind =
      declaration.initializer &&
      (ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer))
        ? "function"
        : "variable";
    return symbolId(kind, filePath, name);
  }
  if (ts.isInterfaceDeclaration(declaration))
    return symbolId("interface", filePath, declaration.name.text);
  if (ts.isTypeAliasDeclaration(declaration))
    return symbolId("type-alias", filePath, declaration.name.text);
  return undefined;
}

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    (parent as ts.NamedDeclaration).name === node ||
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isBindingElement(parent) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node)
  ) {
    return false;
  }
  return true;
}

function expressionFallbackId(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return externalId("unresolved", expression.text);
  if (ts.isPropertyAccessExpression(expression)) {
    return externalId(inferExternalModule(expression), expression.name.text);
  }
  return undefined;
}

function inferExternalModule(expression: ts.Expression): string {
  if (ts.isPropertyAccessExpression(expression)) {
    const root = leftMostIdentifier(expression);
    return root ?? "unresolved";
  }
  return ts.isIdentifier(expression) ? expression.text : "unresolved";
}

function leftMostIdentifier(expression: ts.Expression): string | undefined {
  let current = expression;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current.text : undefined;
}

export function extractFileStructure(context: AnalysisContext): Pick<
  FileRecord,
  "imports" | "exports" | "env" | "operations"
> & {
  diagnostics: DiagnosticRecord[];
  relations: RelationRecord[];
} {
  const imports: ImportRecord[] = [];
  const exports: ExportRecord[] = [];
  const env = new Set<string>();
  const operations: ExternalOperation[] = [];
  const diagnostics: DiagnosticRecord[] = [];
  const relations: RelationRecord[] = [];
  const importedModules = new Map<string, string>();

  for (const statement of context.sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const source = statement.moduleSpecifier.text;
      const specifiers = importSpecifiers(statement);
      for (const specifier of specifiers) importedModules.set(specifier.local, source);
      const resolved = resolveImport(context, source);
      imports.push({
        source,
        specifiers,
        ...(resolved.path ? { resolved: resolved.path } : {}),
        external: resolved.external,
        kind: "esm",
        line: nodeLine(context.sourceFile, statement),
      });
      addImportRelation(context, relations, statement, source, resolved);
      if (!resolved.found && !isBuiltin(source))
        diagnostics.push(unresolvedImport(context, statement, source));
    } else if (ts.isExportDeclaration(statement)) {
      extractExportDeclaration(context, statement, exports, relations);
    } else if (ts.isExportAssignment(statement)) {
      exports.push({
        name: "default",
        local: ts.isIdentifier(statement.expression) ? statement.expression.text : "default",
        default: true,
        line: nodeLine(context.sourceFile, statement),
      });
    }
  }

  visit(context.sourceFile, (node) => {
    if (ts.isCallExpression(node) && isRequireCall(node)) {
      const argument = node.arguments[0];
      if (!argument || !ts.isStringLiteral(argument)) return;
      const source = argument.text;
      const resolved = resolveImport(context, source);
      imports.push({
        source,
        specifiers: [],
        ...(resolved.path ? { resolved: resolved.path } : {}),
        external: resolved.external,
        kind: "commonjs",
        line: nodeLine(context.sourceFile, node),
      });
      addImportRelation(context, relations, node, source, resolved);
      if (!resolved.found && !isBuiltin(source))
        diagnostics.push(unresolvedImport(context, node, source));
    }
    const envName = processEnvName(node);
    if (envName) env.add(envName);
    const operation = externalOperation(node, context.sourceFile, importedModules);
    if (operation) operations.push(operation);
  });

  extractCommonJsExports(context, exports);
  return {
    imports: dedupeImports(imports),
    exports: dedupeExports(exports),
    env: [...env].sort(compareText),
    operations: dedupeOperations(operations),
    diagnostics,
    relations,
  };
}

function importSpecifiers(statement: ts.ImportDeclaration): ImportRecord["specifiers"] {
  const clause = statement.importClause;
  if (!clause) return [];
  const output: ImportRecord["specifiers"] = [];
  const clauseTypeOnly = clause.phaseModifier === ts.SyntaxKind.TypeKeyword;
  if (clause.name) {
    output.push({
      imported: "default",
      local: clause.name.text,
      ...(clauseTypeOnly ? { typeOnly: true } : {}),
    });
  }
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) {
    output.push({
      imported: "*",
      local: bindings.name.text,
      ...(clauseTypeOnly ? { typeOnly: true } : {}),
    });
  } else if (bindings) {
    for (const element of bindings.elements) {
      output.push({
        imported: element.propertyName?.text ?? element.name.text,
        local: element.name.text,
        ...(clauseTypeOnly || element.isTypeOnly ? { typeOnly: true } : {}),
      });
    }
  }
  return output.sort((a, b) => compareText(`${a.imported}:${a.local}`, `${b.imported}:${b.local}`));
}

function extractExportDeclaration(
  context: AnalysisContext,
  statement: ts.ExportDeclaration,
  exports: ExportRecord[],
  relations: RelationRecord[],
): void {
  const source =
    statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : undefined;
  const line = nodeLine(context.sourceFile, statement);
  if (!statement.exportClause) {
    exports.push({ name: "*", ...(source ? { source } : {}), default: false, line });
  } else if (ts.isNamespaceExport(statement.exportClause)) {
    exports.push({
      name: statement.exportClause.name.text,
      ...(source ? { source } : {}),
      default: false,
      line,
    });
  } else {
    for (const element of statement.exportClause.elements) {
      exports.push({
        name: element.name.text,
        local: element.propertyName?.text ?? element.name.text,
        ...(source ? { source } : {}),
        default: element.name.text === "default",
        ...(statement.isTypeOnly || element.isTypeOnly ? { typeOnly: true } : {}),
        line,
      });
    }
  }
  if (source) {
    const resolved = resolveImport(context, source);
    relations.push(
      relation(
        fileId(context.relativePath),
        "reexports",
        resolved.path ? fileId(resolved.path) : externalId(source),
        context,
        statement,
        resolved.found ? 1 : 0.5,
        resolved.found ? "resolved re-export" : "unresolved re-export",
      ),
    );
  }
}

function extractCommonJsExports(context: AnalysisContext, exports: ExportRecord[]): void {
  visit(context.sourceFile, (node) => {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
      return;
    const left = node.left;
    const line = nodeLine(context.sourceFile, node);
    if (
      ts.isPropertyAccessExpression(left) &&
      ts.isIdentifier(left.expression) &&
      left.expression.text === "module" &&
      left.name.text === "exports"
    ) {
      exports.push({
        name: "default",
        ...(ts.isIdentifier(node.right) ? { local: node.right.text } : {}),
        default: true,
        line,
      });
    } else if (
      ts.isPropertyAccessExpression(left) &&
      ((ts.isIdentifier(left.expression) && left.expression.text === "exports") ||
        (ts.isPropertyAccessExpression(left.expression) &&
          ts.isIdentifier(left.expression.expression) &&
          left.expression.expression.text === "module" &&
          left.expression.name.text === "exports"))
    ) {
      exports.push({
        name: left.name.text,
        local: ts.isIdentifier(node.right) ? node.right.text : left.name.text,
        default: false,
        line,
      });
    }
  });
}

interface ImportResolution {
  found: boolean;
  external: boolean;
  path?: string;
}

function resolveImport(context: AnalysisContext, moduleName: string): ImportResolution {
  if (isBuiltin(moduleName) || moduleName.startsWith("node:"))
    return { found: true, external: true };
  const resolution = ts.resolveModuleName(
    moduleName,
    context.sourceFile.fileName,
    context.program.getCompilerOptions(),
    ts.sys,
  ).resolvedModule;
  if (!resolution) return { found: false, external: !moduleName.startsWith(".") };
  if (
    !isPathInside(context.root, resolution.resolvedFileName) ||
    resolution.isExternalLibraryImport
  ) {
    return { found: true, external: true };
  }
  return {
    found: true,
    external: false,
    path: relativePosix(context.root, resolution.resolvedFileName),
  };
}

function addImportRelation(
  context: AnalysisContext,
  output: RelationRecord[],
  node: ts.Node,
  source: string,
  resolved: ImportResolution,
): void {
  output.push(
    relation(
      fileId(context.relativePath),
      "imports",
      resolved.path ? fileId(resolved.path) : externalId(source),
      context,
      node,
      resolved.found ? 1 : 0.5,
      resolved.found ? "module resolution" : "unresolved import text",
    ),
  );
}

function unresolvedImport(
  context: AnalysisContext,
  node: ts.Node,
  source: string,
): DiagnosticRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    code: "unresolved-import",
    severity: "warning",
    message: `Could not resolve import ${source}.`,
    file: context.relativePath,
    line: nodeLine(context.sourceFile, node),
  };
}

function processEnvName(node: ts.Node): string | undefined {
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "process" &&
    node.expression.name.text === "env"
  ) {
    return node.name.text;
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "process" &&
    node.expression.name.text === "env" &&
    ts.isStringLiteral(node.argumentExpression)
  ) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function externalOperation(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  importedModules: Map<string, string>,
): ExternalOperation | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  let root: string | undefined;
  let api: string;
  if (ts.isIdentifier(node.expression)) {
    root = node.expression.text;
    api = root;
  } else if (ts.isPropertyAccessExpression(node.expression)) {
    root = leftMostIdentifier(node.expression);
    api = node.expression.getText(sourceFile);
  } else return undefined;
  const source = root ? importedModules.get(root) : undefined;
  let kind: ExternalOperation["kind"] | undefined;
  if (
    root === "fetch" ||
    source === "axios" ||
    source === "http" ||
    source === "https" ||
    source?.startsWith("node:http")
  )
    kind = "http";
  else if (source === "fs" || source === "fs/promises" || source?.startsWith("node:fs"))
    kind = "filesystem";
  else if (source && /(?:prisma|typeorm|mongoose|sequelize|pg|mysql|database|redis)/i.test(source))
    kind = "database";
  else if (source && /(?:bull|queue|kafka|amqp|rabbit)/i.test(source)) kind = "queue";
  return kind ? { kind, api, line: nodeLine(sourceFile, node) } : undefined;
}

function isRequireCall(node: ts.CallExpression): boolean {
  return (
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    node.arguments.length > 0
  );
}

function dedupeImports(values: ImportRecord[]): ImportRecord[] {
  const map = new Map<string, ImportRecord>();
  for (const value of values) {
    map.set(`${value.kind}:${value.source}:${value.line}`, value);
  }
  return [...map.values()].sort((a, b) =>
    compareText(`${a.source}:${a.line}`, `${b.source}:${b.line}`),
  );
}

function dedupeExports(values: ExportRecord[]): ExportRecord[] {
  const map = new Map<string, ExportRecord>();
  for (const value of values) map.set(`${value.name}:${value.source ?? ""}:${value.line}`, value);
  return [...map.values()].sort((a, b) =>
    compareText(`${a.name}:${a.line}`, `${b.name}:${b.line}`),
  );
}

function dedupeOperations(values: ExternalOperation[]): ExternalOperation[] {
  const map = new Map<string, ExternalOperation>();
  for (const value of values) map.set(`${value.kind}:${value.api}:${value.line}`, value);
  return [...map.values()].sort((a, b) =>
    compareText(`${a.kind}:${a.line}:${a.api}`, `${b.kind}:${b.line}:${b.api}`),
  );
}

export function relation(
  from: string,
  type: RelationRecord["type"],
  to: string,
  context: AnalysisContext,
  node: ts.Node,
  confidence: number,
  explanation: string,
): RelationRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    from,
    type,
    to,
    confidence,
    origin: {
      file: context.relativePath,
      line: nodeLine(context.sourceFile, node),
      range: nodeRange(context.sourceFile, node),
      explanation,
      classification: confidence === 1 ? "exact" : "heuristic",
      analyzer: "typescript-node",
    },
  };
}
