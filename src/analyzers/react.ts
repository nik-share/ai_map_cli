import path from "node:path";

import ts from "typescript";

import { SCHEMA_VERSION } from "../constants.js";
import { symbolId } from "../ids.js";
import type {
  AnalysisContribution,
  AnalysisContext,
  FrameworkAnalyzer,
  RelationRecord,
} from "../types.js";
import {
  compactText,
  hasDefaultModifier,
  hasExportModifier,
  makeSymbol,
  nodeLine,
  nodeRange,
  propertyNameText,
} from "./helpers.js";

const REACT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const REACT_BUILTIN_HOOKS = new Set([
  "useState",
  "useReducer",
  "useMemo",
  "useCallback",
  "useEffect",
  "useLayoutEffect",
  "useContext",
]);
const REACT_FACTORYS = new Set(["memo", "forwardRef"]);

interface ImportProfile {
  hookAliases: Map<string, string>;
  namespaceAliases: Set<string>;
  localImports: Map<string, string>;
}

interface ComponentDescriptor {
  name: string;
  id: string;
  body: ts.ConciseBody;
}

interface NamedSyntaxCandidate {
  name: string;
  node: ts.Node;
}

export class ReactAnalyzer implements FrameworkAnalyzer {
  readonly name = "react";
  readonly version = "0.1.0";

  supports(context: AnalysisContext): boolean {
    const extension = path.extname(context.relativePath).toLowerCase();
    if (!REACT_EXTENSIONS.has(extension)) return false;
    return (
      hasDirective(context.sourceFile, "use client") ||
      hasDirective(context.sourceFile, "use server") ||
      hasReactImport(context.sourceFile) ||
      hasAnyJsx(context.sourceFile)
    );
  }

  analyze(context: AnalysisContext): AnalysisContribution {
    const profile = collectImportProfile(context.sourceFile);
    const symbols: AnalysisContribution["symbols"] = [];
    const relations: RelationRecord[] = [];
    const componentIds = new Map<string, string>();
    const hookIds = new Map<string, string>();
    const components: ComponentDescriptor[] = [];

    for (const statement of context.sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const name = statement.name.text;
        if (isCustomHookName(name) && statement.body) {
          const symbol = makeSymbol(context, statement, "react-hook", {
            name,
            exported: isNameExported(context.sourceFile, statement),
            defaultExport: hasDefaultModifier(statement),
            facts: { runtime: inferRuntime(context.sourceFile) },
          });
          symbols.push(symbol);
          hookIds.set(name.toLowerCase(), symbol.id);
          continue;
        }
        if (statement.body && isComponentName(name, statement.body)) {
          const facts = collectComponentFacts(
            context,
            name,
            statement.parameters,
            statement.body,
            profile,
          );
          const symbol = makeSymbol(context, statement, "react-component", {
            name,
            exported: isNameExported(context.sourceFile, statement),
            defaultExport: hasDefaultModifier(statement),
            facts,
          });
          symbols.push(symbol);
          componentIds.set(name.toLowerCase(), symbol.id);
          components.push({ name, id: symbol.id, body: statement.body });
          continue;
        }
      }

      if (ts.isVariableStatement(statement)) {
        const exported = isNameExported(context.sourceFile, statement);
        const defaultExport = hasDefaultModifier(statement);
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
          const name = declaration.name.text;

          if (isContextFactory(declaration.initializer, profile)) {
            symbols.push(
              makeSymbol(context, declaration, "react-context", {
                name,
                exported,
                defaultExport,
                facts: { runtime: inferRuntime(context.sourceFile), type: "react-context" },
              }),
            );
            continue;
          }

          if (isCustomHookName(name) && isFunctionLikeExpression(declaration.initializer)) {
            const body = functionBody(declaration.initializer);
            if (body) {
              const symbol = makeSymbol(context, declaration, "react-hook", {
                name,
                exported,
                defaultExport,
                facts: { runtime: inferRuntime(context.sourceFile) },
              });
              symbols.push(symbol);
              hookIds.set(name.toLowerCase(), symbol.id);
            }
            continue;
          }

          const extracted = extractComponentFromExpression(declaration.initializer, name, profile);
          if (!extracted) continue;

          const facts = collectComponentFacts(
            context,
            name,
            extracted.parameters,
            extracted.body,
            profile,
          );
          const symbol = makeSymbol(context, declaration, "react-component", {
            name,
            exported,
            defaultExport,
            facts,
          });
          symbols.push(symbol);
          componentIds.set(name.toLowerCase(), symbol.id);
          components.push({ name, id: symbol.id, body: extracted.body });
        }
      }

      if (ts.isClassDeclaration(statement) && statement.name && isReactClassComponent(statement)) {
        const name = statement.name.text;
        const renderMethod = statement.members.find(
          (member): member is ts.MethodDeclaration =>
            ts.isMethodDeclaration(member) &&
            ts.isIdentifier(member.name) &&
            member.name.text === "render" &&
            Boolean(member.body),
        );
        if (!renderMethod?.body) continue;
        const symbol = makeSymbol(context, statement, "react-component", {
          name,
          exported: isNameExported(context.sourceFile, statement),
          defaultExport: hasDefaultModifier(statement),
          facts: { runtime: inferRuntime(context.sourceFile), class: true },
        });
        symbols.push(symbol);
        componentIds.set(name.toLowerCase(), symbol.id);
        components.push({ name, id: symbol.id, body: renderMethod.body });
      }
    }

    for (const component of components) {
      const rendered = collectRenderedComponents(component.body);
      for (const candidate of rendered) {
        const to =
          componentIds.get(candidate.name.toLowerCase()) ??
          resolveImportedReactComponent(context, profile, candidate.name) ??
          symbolId("react-component", context.relativePath, candidate.name);
        relations.push(
          makeRelation(component.id, "renders", to, context, candidate.node, 0.95, "JSX render"),
        );
      }

      for (const candidate of collectCalledCustomHooks(component.body, profile)) {
        const to =
          hookIds.get(candidate.name.toLowerCase()) ??
          resolveImportedReactSymbol(context, profile, candidate.name, "react-hook") ??
          symbolId("react-hook", context.relativePath, candidate.name);
        relations.push(
          makeRelation(
            component.id,
            "uses-hook",
            to,
            context,
            candidate.node,
            0.95,
            "custom hook call",
          ),
        );
      }
    }

    return { symbols, relations, frameworks: ["react"] };
  }
}

export default ReactAnalyzer;

function hasReactImport(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "react",
  );
}

function hasDirective(sourceFile: ts.SourceFile, value: string): boolean {
  return sourceFile.statements
    .slice(0, 8)
    .some(
      (statement) =>
        ts.isExpressionStatement(statement) &&
        ts.isStringLiteral(statement.expression) &&
        statement.expression.text === value,
    );
}

function hasAnyJsx(sourceFile: ts.SourceFile): boolean {
  let found = false;
  visit(sourceFile, (node) => {
    if (found) return;
    if (
      ts.isJsxElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxOpeningElement(node) ||
      ts.isJsxFragment(node)
    ) {
      found = true;
    }
  });
  return found;
}

function inferRuntime(sourceFile: ts.SourceFile): string {
  if (hasDirective(sourceFile, "use client")) return "client";
  if (hasDirective(sourceFile, "use server")) return "server";
  return "unclassified";
}

function isNameExported(sourceFile: ts.SourceFile, node: ts.Node): boolean {
  return hasExportModifier(node);
}

function collectImportProfile(sourceFile: ts.SourceFile): ImportProfile {
  const hookAliases = new Map<string, string>();
  const namespaceAliases = new Set<string>();
  const localImports = new Map<string, string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const source = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;

    if (source === "react") {
      if (clause.name) {
        hookAliases.set(clause.name.text, clause.name.text);
      }
      if (!clause.namedBindings) continue;
      if (ts.isNamespaceImport(clause.namedBindings)) {
        namespaceAliases.add(clause.namedBindings.name.text);
        continue;
      }
      for (const item of clause.namedBindings.elements) {
        const local = item.name.text;
        const imported = item.propertyName?.text ?? item.name.text;
        hookAliases.set(local, imported);
      }
      continue;
    }

    if (source.startsWith("./") || source.startsWith("../")) {
      if (!clause.namedBindings) continue;
      if (ts.isNamedImports(clause.namedBindings)) {
        for (const item of clause.namedBindings.elements) {
          localImports.set(item.name.text, source);
        }
      } else if (ts.isNamespaceImport(clause.namedBindings)) {
        localImports.set(clause.namedBindings.name.text, source);
      }
      continue;
    }
  }

  return { hookAliases, namespaceAliases, localImports };
}

function isCustomHookName(name: string): boolean {
  return /^use[A-Z]/.test(name);
}

function isComponentName(name: string, body: ts.ConciseBody | undefined): boolean {
  return Boolean(body && isUpperCase(name) && !isCustomHookName(name) && containsJsx(body));
}

function isUpperCase(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function isContextFactory(value: ts.Expression, profile: ImportProfile): boolean {
  return (
    ts.isCallExpression(value) && resolveCallName(value.expression, profile) === "createContext"
  );
}

function extractComponentFromExpression(
  value: ts.Expression,
  name: string,
  profile: ImportProfile,
): { body: ts.ConciseBody; parameters: readonly ts.ParameterDeclaration[] } | undefined {
  if (!isUpperCase(name) || isCustomHookName(name)) return undefined;

  if (isFunctionLikeExpression(value)) {
    return { body: value.body, parameters: value.parameters };
  }

  if (ts.isClassExpression(value)) {
    const renderMethod = value.members.find(
      (member): member is ts.MethodDeclaration =>
        ts.isMethodDeclaration(member) &&
        ts.isIdentifier(member.name) &&
        member.name.text === "render" &&
        Boolean(member.body),
    );
    if (!renderMethod?.body) return undefined;
    return { body: renderMethod.body, parameters: renderMethod.parameters };
  }

  if (ts.isCallExpression(value)) {
    const calledName = resolveCallName(value.expression, profile);
    if (!calledName || !REACT_FACTORYS.has(calledName) || value.arguments.length === 0)
      return undefined;
    const first = value.arguments[0];
    if (!ts.isFunctionLike(first) || !containsJsx(first.body)) return undefined;
    return { body: first.body, parameters: first.parameters };
  }

  return undefined;
}

function isFunctionLikeExpression(
  expression: ts.Expression,
): expression is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
}

function isReactClassComponent(statement: ts.ClassDeclaration): boolean {
  if (!statement.heritageClauses) return false;
  return statement.heritageClauses.some((clause) =>
    clause.types.some((item) => {
      const expr = item.expression;
      const typeName = ts.isIdentifier(expr)
        ? expr.text
        : ts.isPropertyAccessExpression(expr)
          ? expr.name.text
          : undefined;
      return typeName === "Component" || typeName === "PureComponent";
    }),
  );
}

function functionBody(expression: ts.Expression): ts.ConciseBody | undefined {
  return isFunctionLikeExpression(expression) ? expression.body : undefined;
}

function collectComponentFacts(
  context: AnalysisContext,
  name: string,
  parameters: readonly ts.ParameterDeclaration[],
  body: ts.ConciseBody,
  profile: ImportProfile,
) {
  const facts: Record<string, string> = {
    runtime: inferRuntime(context.sourceFile),
  };

  const props = collectProps(context, parameters[0]);
  if (props.length > 0) {
    facts.props = `${name.toLowerCase()}props:${props.join(",")}`;
  }

  const behavior = collectComponentBehavior(context, body, profile);
  if (behavior.state.length > 0) facts.state = behavior.state.join(",");
  if (behavior.memo.length > 0) facts.memo = behavior.memo.join(",");
  if (behavior.effects.length > 0) facts.effects = behavior.effects.join(",");
  if (behavior.customHooks.length > 0) facts.hooks = behavior.customHooks.join(",");
  return facts;
}

function collectProps(context: AnalysisContext, parameter?: ts.ParameterDeclaration): string[] {
  if (!parameter) return [];
  const values: string[] = [];
  collectBindingNames(parameter.name, values);
  if (parameter.type) {
    values.push(...collectInterfaceMembers(parameter.type, context));
  }
  return dedupe(values);
}

function collectComponentBehavior(
  context: AnalysisContext,
  body: ts.ConciseBody,
  profile: ImportProfile,
): { state: string[]; memo: string[]; effects: string[]; customHooks: string[] } {
  const state: string[] = [];
  const memo: string[] = [];
  const effects: string[] = [];
  const customHooks: string[] = [];

  visit(body, (node) => {
    if (!ts.isCallExpression(node)) return;
    const called = resolveCallName(node.expression, profile);
    if (!called) return;

    const declaration = variableDeclarationOfCall(node);
    if (called === "useState" || called === "useReducer") {
      if (declaration?.name) {
        const declaredNames: string[] = [];
        collectBindingNames(declaration.name, declaredNames);
        state.push(...declaredNames);
      }
      if (called === "useReducer") state.push("reducer");
      return;
    }

    if (called === "useMemo" || called === "useCallback") {
      const target =
        declaration?.name && ts.isIdentifier(declaration.name) ? declaration.name.text : called;
      const dependencies = dependencyText(node.arguments[1], context.sourceFile);
      memo.push(`${called.toLowerCase()}:${target.toLowerCase()}<-${dependencies}`);
      return;
    }

    if (called === "useEffect" || called === "useLayoutEffect") {
      const deps = node.arguments[1]
        ? compactText(node.arguments[1].getText(context.sourceFile))
        : "[]";
      effects.push(`useeffect:${deps}`);
      return;
    }

    if (called.startsWith("use") && !REACT_BUILTIN_HOOKS.has(called)) {
      customHooks.push(called.toLowerCase());
    }
  });

  return {
    state: dedupe(state),
    memo: dedupe(memo),
    effects: dedupe(effects),
    customHooks: dedupe(customHooks),
  };
}

function collectCalledCustomHooks(node: ts.Node, profile: ImportProfile): NamedSyntaxCandidate[] {
  const hooks = new Map<string, NamedSyntaxCandidate>();
  visit(node, (current) => {
    if (!ts.isCallExpression(current)) return;
    const called = resolveCallName(current.expression, profile);
    if (called && called.startsWith("use") && !REACT_BUILTIN_HOOKS.has(called)) {
      const key = called.toLowerCase();
      if (!hooks.has(key)) hooks.set(key, { name: called, node: current });
    }
  });
  return [...hooks.values()];
}

function collectRenderedComponents(node: ts.Node): NamedSyntaxCandidate[] {
  const components = new Map<string, NamedSyntaxCandidate>();
  visit(node, (current) => {
    if (!ts.isJsxElement(current) && !ts.isJsxSelfClosingElement(current)) return;
    const evidenceNode = ts.isJsxElement(current) ? current.openingElement : current;
    const tag = jsxTagName(evidenceNode.tagName);
    if (tag && isUpperCase(tag) && !components.has(tag.toLowerCase())) {
      components.set(tag.toLowerCase(), { name: tag, node: evidenceNode });
    }
  });
  return [...components.values()];
}

function resolveImportedReactComponent(
  context: AnalysisContext,
  profile: ImportProfile,
  renderedName: string,
): string | undefined {
  return resolveImportedReactSymbol(context, profile, renderedName, "react-component");
}

function resolveImportedReactSymbol(
  context: AnalysisContext,
  profile: ImportProfile,
  importedName: string,
  kind: "react-component" | "react-hook",
): string | undefined {
  const source = profile.localImports.get(importedName);
  if (!source) return undefined;
  const relative = path.posix.normalize(
    path.join(path.posix.dirname(context.relativePath), source),
  );
  const candidates = [
    relative,
    `${relative}.ts`,
    `${relative}.tsx`,
    `${relative}.js`,
    `${relative}.jsx`,
    `${relative}/index.ts`,
    `${relative}/index.tsx`,
  ];
  for (const candidate of candidates) {
    const absolute = path.resolve(context.root, candidate);
    if (context.program.getSourceFile(absolute)) {
      return symbolId(kind, candidate, importedName);
    }
  }
  return symbolId(kind, relative, importedName);
}

function dependencyText(expression: ts.Expression | undefined, sourceFile: ts.SourceFile): string {
  if (!expression || !ts.isArrayLiteralExpression(expression)) return "[]";
  return expression.elements.map((element) => compactText(element.getText(sourceFile))).join(",");
}

function resolveCallName(
  expression: ts.LeftHandSideExpression,
  profile: ImportProfile,
): string | undefined {
  if (ts.isIdentifier(expression)) {
    return profile.hookAliases.get(expression.text) ?? expression.text;
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    profile.namespaceAliases.has(expression.expression.text)
  ) {
    return expression.name.text;
  }
  return undefined;
}

function variableDeclarationOfCall(node: ts.CallExpression): ts.VariableDeclaration | undefined {
  let current = node.parent as ts.Node | undefined;
  while (current) {
    if (ts.isVariableDeclaration(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function collectBindingNames(name: ts.BindingName, values: string[]): void {
  if (ts.isIdentifier(name)) {
    values.push(name.text.toLowerCase());
    return;
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) collectBindingNames(element.name, values);
    }
  }
}

function collectInterfaceMembers(typeNode: ts.TypeNode, context: AnalysisContext): string[] {
  if (ts.isTypeLiteralNode(typeNode)) {
    return typeNode.members.flatMap((member) => {
      const name = propertyNameText(member.name);
      return name ? [name.toLowerCase()] : [];
    });
  }

  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const symbol = context.checker.getSymbolAtLocation(typeNode.typeName);
    const resolved =
      symbol && symbol.flags & ts.SymbolFlags.Alias
        ? context.checker.getAliasedSymbol(symbol)
        : symbol;
    const declaration = resolved?.declarations?.[0];
    if (declaration && ts.isInterfaceDeclaration(declaration)) {
      return declaration.members.flatMap((member) => {
        const name = propertyNameText(member.name);
        return name ? [name.toLowerCase()] : [];
      });
    }
  }

  return [];
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  visit(node, (current) => {
    if (
      ts.isJsxElement(current) ||
      ts.isJsxSelfClosingElement(current) ||
      ts.isJsxOpeningElement(current) ||
      ts.isJsxFragment(current)
    ) {
      found = true;
    }
  });
  return found;
}

function jsxTagName(tag: ts.JsxTagNameExpression): string | undefined {
  if (ts.isIdentifier(tag) || ts.isStringLiteral(tag)) return tag.text;
  if (ts.isPropertyAccessExpression(tag)) return tag.name.text;
  return undefined;
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function makeRelation(
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
      classification: "framework-derived",
      analyzer: "react",
    },
  };
}
