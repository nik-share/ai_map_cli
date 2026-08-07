import ts from "typescript";

import { SCHEMA_VERSION } from "../constants.js";
import { routeId, symbolId } from "../ids.js";
import type {
  AnalysisContribution,
  AnalysisContext,
  FrameworkAnalyzer,
  RelationRecord,
} from "../types.js";
import {
  compactText,
  decoratorsOf,
  hasDefaultModifier,
  hasExportModifier,
  makeSymbol,
  nodeLine,
  nodeRange,
} from "./helpers.js";

const METHOD_DECORATORS = new Set([
  "Get",
  "Post",
  "Put",
  "Patch",
  "Delete",
  "Head",
  "Options",
  "All",
]);
const NEST_DECORATORS = new Set([
  "Module",
  "Controller",
  "Injectable",
  "Guard",
  "UseGuards",
  "Body",
  "Param",
  ...METHOD_DECORATORS,
]);

interface ImportAliasMap {
  named: Record<string, string>;
  namespaces: Set<string>;
}

interface ModuleMetadata {
  controllers: string[];
  providers: string[];
  imports: string[];
  exports: string[];
}

const registeredNestJsAnalyzers = new WeakSet();

export class NestJsAnalyzer implements FrameworkAnalyzer {
  readonly name = "nestjs";
  readonly version = "0.1.0-experimental";

  constructor() {
    registeredNestJsAnalyzers.add(this);
  }

  supports(context: AnalysisContext): boolean {
    if (!context.relativePath.endsWith(".ts")) return false;
    return hasAnyNestImport(context.sourceFile) || containsReferencedBodyDto(context);
  }

  analyze(context: AnalysisContext): AnalysisContribution {
    const symbols: AnalysisContribution["symbols"] = [];
    const relations: RelationRecord[] = [];
    const bodyDtoSymbolIds = collectBodyDtoSymbolIds(context);

    const aliases = collectImportAliases(context.sourceFile);
    const moduleMembership = collectModuleMembership(context);

    for (const statement of context.sourceFile.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue;

      const className = statement.name.text;
      const decoratorNames = collectDecoratorNames(decoratorsOf(statement), aliases);
      const kind = classifyClass(
        className,
        decoratorNames,
        symbolId("dto", context.relativePath, className),
        bodyDtoSymbolIds,
      );

      if (kind === "dto") {
        symbols.push(
          makeSymbol(context, statement, "dto", {
            name: className,
            exported: hasExportModifier(statement),
            defaultExport: hasDefaultModifier(statement),
            facts: {
              name: className.toLowerCase(),
              kind: "dto",
            },
          }),
        );
        continue;
      }

      if (!kind) continue;

      const symbol = makeSymbol(context, statement, kind, {
        name: className,
        exported: hasExportModifier(statement),
        defaultExport: hasDefaultModifier(statement),
        facts: {
          name: className.toLowerCase(),
          kind,
        },
      });
      symbols.push(symbol);

      if (kind === "nest-module") {
        const metadata = collectModuleMetadata(statement, aliases);
        if (metadata.controllers.length > 0) {
          symbol.facts.controllers = compactText(metadata.controllers.join(","));
          for (const controller of metadata.controllers) {
            const controllerId = resolveLocalClassId(context, controller, "nest-controller");
            if (!controllerId) continue;
            relations.push(
              makeRelation(
                symbol.id,
                "contains",
                controllerId,
                context,
                statement,
                1,
                "module controller",
              ),
            );
          }
        }
        if (metadata.providers.length > 0) {
          symbol.facts.providers = compactText(metadata.providers.join(","));
          for (const provider of metadata.providers) {
            const providerId = resolveLocalClassId(context, provider, "nest-provider");
            if (!providerId) continue;
            relations.push(
              makeRelation(
                symbol.id,
                "contains",
                providerId,
                context,
                statement,
                1,
                "module provider",
              ),
            );
          }
        }
        if (metadata.imports.length > 0) {
          symbol.facts.imports = compactText(metadata.imports.join(","));
        }
        if (metadata.exports.length > 0) {
          symbol.facts.exports = compactText(metadata.exports.join(","));
        }
      }

      if (kind === "nest-controller") {
        const baseRoute = collectControllerRoute(statement, aliases);
        symbol.facts.baseRoute = baseRoute;
        symbol.facts.kind = "controller";

        const controllerRoutes = collectControllerMethods(context, statement, className, aliases);
        relations.push(...controllerRoutes.relations);
        if (controllerRoutes.summary.length > 0) {
          symbol.facts.routes = compactText(controllerRoutes.summary.join(","));
        }

        const guards = collectClassUseGuards(statement, aliases);
        if (guards.length > 0) {
          symbol.facts.guards = compactText(guards.join(","));
        }
      }

      for (const injected of collectConstructorInjections(context, statement)) {
        relations.push(
          makeRelation(
            symbol.id,
            "injects",
            injected,
            context,
            statement,
            1,
            "constructor injection",
          ),
        );
      }

      const moduleId = moduleMembership.get(className);
      if (moduleId) {
        relations.push(
          makeRelation(
            symbol.id,
            "belongs-to-module",
            moduleId,
            context,
            statement,
            1,
            "module membership",
          ),
        );
      }
    }

    return { symbols, relations, frameworks: ["nestjs"] };
  }
}

const nestJsSupports = NestJsAnalyzer.prototype.supports.bind(NestJsAnalyzer.prototype);
const nestJsAnalyze = NestJsAnalyzer.prototype.analyze.bind(NestJsAnalyzer.prototype);

/** Return immutable canonical methods only for an unmodified, directly constructed instance. */
export function trustedNestJsAnalyzerMethods(analyzer: FrameworkAnalyzer):
  | {
      supports(context: AnalysisContext): boolean;
      analyze(context: AnalysisContext): AnalysisContribution | Promise<AnalysisContribution>;
    }
  | undefined {
  if (!registeredNestJsAnalyzers.has(analyzer)) return undefined;
  if (Object.getPrototypeOf(analyzer) !== NestJsAnalyzer.prototype) return undefined;
  if (Object.hasOwn(analyzer, "supports") || Object.hasOwn(analyzer, "analyze")) {
    return undefined;
  }
  const name = Object.getOwnPropertyDescriptor(analyzer, "name");
  const version = Object.getOwnPropertyDescriptor(analyzer, "version");
  if (name?.value !== "nestjs" || version?.value !== "0.1.0-experimental") return undefined;
  return {
    supports: (context) => nestJsSupports(context),
    analyze: (context) => nestJsAnalyze(context),
  };
}

export default NestJsAnalyzer;

function hasAnyNestImport(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.startsWith("@nestjs/"),
  );
}

function collectImportAliases(sourceFile: ts.SourceFile): ImportAliasMap {
  const aliases: ImportAliasMap = {
    named: {},
    namespaces: new Set<string>(),
  };
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    if (!statement.moduleSpecifier.text.startsWith("@nestjs/")) continue;
    const clause = statement.importClause;
    if (!clause || !clause.namedBindings) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      aliases.namespaces.add(clause.namedBindings.name.text);
      continue;
    }
    if (!ts.isNamedImports(clause.namedBindings)) continue;
    for (const item of clause.namedBindings.elements) {
      aliases.named[item.name.text] = item.propertyName ? item.propertyName.text : item.name.text;
    }
  }
  return aliases;
}

function classifyClass(
  className: string,
  decorators: string[],
  symbolIdValue: string,
  dtoSymbolIds: Set<string>,
):
  | "nest-module"
  | "nest-controller"
  | "nest-provider"
  | "nest-guard"
  | "nest-interceptor"
  | "nest-pipe"
  | "nest-filter"
  | "nest-gateway"
  | "dto"
  | undefined {
  if (dtoSymbolIds.has(symbolIdValue)) return "dto";
  if (decorators.includes("Module")) return "nest-module";
  if (decorators.includes("Controller")) return "nest-controller";
  if (!decorators.includes("Injectable")) return undefined;
  if (className.endsWith("Guard")) return "nest-guard";
  if (className.endsWith("Interceptor")) return "nest-interceptor";
  if (className.endsWith("Pipe")) return "nest-pipe";
  if (className.endsWith("Filter")) return "nest-filter";
  if (className.endsWith("Gateway")) return "nest-gateway";
  return "nest-provider";
}

function collectDecoratorNames(
  decorators: readonly ts.Decorator[],
  aliases: ImportAliasMap,
): string[] {
  const names: string[] = [];
  for (const decorator of decorators) {
    const name = resolveDecoratorName(decorator.expression, aliases);
    if (name && NEST_DECORATORS.has(name)) {
      names.push(name);
    }
  }
  return names;
}

function resolveDecoratorName(
  expression: ts.Expression,
  aliases: ImportAliasMap,
): string | undefined {
  const target = ts.isCallExpression(expression) ? expression.expression : expression;
  if (ts.isIdentifier(target)) {
    const resolved = aliases.named[target.text];
    if (resolved) return resolved;
    return undefined;
  }
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
    if (aliases.namespaces.has(target.expression.text)) return target.name.text;
  }
  return undefined;
}

function collectControllerRoute(classNode: ts.ClassDeclaration, aliases: ImportAliasMap): string {
  for (const decorator of decoratorsOf(classNode)) {
    const expression = decorator.expression;
    const call = ts.isCallExpression(expression) ? expression : undefined;
    if (!call) continue;
    const name = resolveDecoratorName(expression, aliases);
    if (!name) continue;
    if (name !== "Controller") continue;
    const arg = call.arguments[0];
    if (!arg) return "/";
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      const value = arg.text.trim();
      return value.startsWith("/") ? value : `/${value}`;
    }
  }
  return "/";
}

function collectControllerMethods(
  context: AnalysisContext,
  controller: ts.ClassDeclaration,
  className: string,
  aliases: ImportAliasMap,
): { relations: RelationRecord[]; summary: string[] } {
  const relations: RelationRecord[] = [];
  const summary: string[] = [];
  const baseRoute = collectControllerRoute(controller, aliases);

  for (const member of controller.members) {
    if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;

    const methodName = member.name.text;
    const methodDecorators = collectDecoratorNames(decoratorsOf(member), aliases);
    const methodVerbs = methodDecorators.filter((name) => METHOD_DECORATORS.has(name));
    if (methodVerbs.length === 0) continue;

    const methodRoute = collectMethodRoute(member, aliases);
    const fullRoute = combineRoutes(baseRoute, methodRoute);

    for (const verb of methodVerbs) {
      const lower = verb.toLowerCase();
      const methodId = symbolId("method", context.relativePath, methodName, className);
      relations.push(
        makeRelation(
          methodId,
          "handles-route",
          routeId(lower, fullRoute),
          context,
          member,
          1,
          "http method route",
        ),
      );
      summary.push(`${lower} ${fullRoute}`);

      const dto = collectBodyDto(member, aliases, context);
      if (dto) {
        relations.push(
          makeRelation(methodId, "consumes-dto", dto, context, member, 1, "dto usage"),
        );
      }
    }
  }

  return { relations, summary: dedupe(summary) };

  function collectMethodRoute(
    methodNode: ts.MethodDeclaration,
    aliasesMap: ImportAliasMap,
  ): string {
    for (const decorator of decoratorsOf(methodNode)) {
      const expression = decorator.expression;
      const call = ts.isCallExpression(expression) ? expression : undefined;
      if (!call) continue;
      const name = resolveDecoratorName(expression, aliasesMap);
      if (!name) continue;
      if (!METHOD_DECORATORS.has(name)) continue;
      const arg = call.arguments[0];
      if (!arg) return "/";
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
        const route = arg.text.trim();
        return route.startsWith("/") ? route : `/${route}`;
      }
    }
    return "/";
  }
}

function collectBodyDto(
  method: ts.MethodDeclaration,
  aliases: ImportAliasMap,
  context: AnalysisContext,
): string | undefined {
  return collectBodyDtoFromMethod(method, aliases, context);
}

function collectBodyDtoSymbolIds(context: AnalysisContext): Set<string> {
  const ids = new Set<string>();
  for (const source of context.program
    .getSourceFiles()
    .filter((source) => !source.isDeclarationFile)) {
    if (!hasAnyNestImport(source)) continue;
    const sourceRelative = relativeFromAbsolute(context.root, source.fileName);
    if (!sourceRelative) continue;
    const aliases = collectImportAliases(source);
    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement)) continue;
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const dtoId = collectBodyDtoFromMethod(member, aliases, context);
        if (dtoId) ids.add(dtoId);
      }
    }
  }
  return ids;
}

function collectBodyDtoFromMethod(
  method: ts.MethodDeclaration,
  aliases: ImportAliasMap,
  context: AnalysisContext,
): string | undefined {
  const param = method.parameters.find((item) => hasDecorator(item, "Body", aliases));
  if (!param?.type || !ts.isTypeReferenceNode(param.type) || !ts.isIdentifier(param.type.typeName))
    return undefined;

  const declaration = resolveIdentifierDeclaration(context, param.type.typeName);
  if (!declaration || !ts.isClassDeclaration(declaration) || !declaration.name) return undefined;
  const relative = relativeFromRoot(context, declaration.getSourceFile().fileName);
  if (!relative) return undefined;

  return symbolId("dto", relative, declaration.name.text);
}

function containsReferencedBodyDto(context: AnalysisContext): boolean {
  const dtoIds = collectBodyDtoSymbolIds(context);
  return context.sourceFile.statements.some(
    (statement) =>
      ts.isClassDeclaration(statement) &&
      statement.name !== undefined &&
      dtoIds.has(symbolId("dto", context.relativePath, statement.name.text)),
  );
}

function resolveIdentifierDeclaration(
  context: AnalysisContext,
  identifier: ts.Identifier,
): ts.Declaration | undefined {
  let symbol = context.checker.getSymbolAtLocation(identifier);
  if (!symbol) return undefined;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = context.checker.getAliasedSymbol(symbol);
  }
  return symbol.valueDeclaration ?? symbol.declarations?.[0];
}

function resolveLocalClassId(
  context: AnalysisContext,
  localName: string,
  kind: "nest-controller" | "nest-provider",
): string | undefined {
  const identifier = findTopLevelIdentifier(context.sourceFile, localName);
  if (!identifier) return undefined;
  const declaration = resolveIdentifierDeclaration(context, identifier);
  if (!declaration || !ts.isClassDeclaration(declaration) || !declaration.name) return undefined;
  const relative = relativeFromRoot(context, declaration.getSourceFile().fileName);
  if (!relative) return undefined;
  return symbolId(kind, relative, declaration.name.text);
}

function findTopLevelIdentifier(
  sourceFile: ts.SourceFile,
  localName: string,
): ts.Identifier | undefined {
  for (const statement of sourceFile.statements) {
    if (ts.isClassDeclaration(statement) && statement.name?.text === localName) {
      return statement.name;
    }
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause?.name?.text === localName) return clause.name;
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
    const match = clause.namedBindings.elements.find((item) => item.name.text === localName);
    if (match) return match.name;
  }
  return undefined;
}

function relativeFromAbsolute(root: string, absolutePath: string): string | undefined {
  const normalized = absolutePath.replace(/\\/g, "/");
  const normalizedRoot = root.replace(/\\/g, "/");
  if (normalized !== normalizedRoot && !normalized.startsWith(`${normalizedRoot}/`))
    return undefined;
  const remainder = normalized.slice(normalizedRoot.length);
  return remainder.startsWith("/") ? remainder.slice(1) : remainder;
}

function hasDecorator(
  parameter: ts.ParameterDeclaration,
  target: string,
  aliases: ImportAliasMap,
): boolean {
  for (const decorator of decoratorsOf(parameter)) {
    const resolved = resolveDecoratorName(decorator.expression, aliases);
    if (resolved === target) return true;
  }
  return false;
}

function collectConstructorInjections(
  context: AnalysisContext,
  classNode: ts.ClassDeclaration,
): string[] {
  const constructorNode = classNode.members.find(ts.isConstructorDeclaration);
  if (!constructorNode) return [];

  const dependencies: string[] = [];
  for (const parameter of constructorNode.parameters) {
    if (
      !parameter.type ||
      !ts.isTypeReferenceNode(parameter.type) ||
      !ts.isIdentifier(parameter.type.typeName)
    )
      continue;

    const declaration = resolveIdentifierDeclaration(context, parameter.type.typeName);
    if (!declaration) continue;
    const relative = relativeFromRoot(context, declaration.getSourceFile().fileName);
    if (!relative) continue;
    const targetName =
      ts.isClassDeclaration(declaration) && declaration.name
        ? declaration.name.text
        : parameter.type.typeName.text;
    dependencies.push(symbolId("nest-provider", relative, targetName));
  }

  return dedupe(dependencies);
}

function collectModuleMetadata(
  classNode: ts.ClassDeclaration,
  aliases: ImportAliasMap,
): ModuleMetadata {
  const defaults: ModuleMetadata = { controllers: [], providers: [], imports: [], exports: [] };
  for (const decorator of decoratorsOf(classNode)) {
    const expression = decorator.expression;
    const call = ts.isCallExpression(expression) ? expression : undefined;
    if (!call) continue;

    const name = resolveDecoratorName(expression, aliases);
    if (!name) continue;
    if (name !== "Module" || call.arguments.length === 0) continue;
    const arg = call.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) continue;

    for (const property of arg.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
        continue;
      const propertyName = ts.isIdentifier(property.name)
        ? property.name.text
        : ts.isStringLiteral(property.name)
          ? property.name.text
          : undefined;
      if (!propertyName) continue;

      if (!(propertyName in defaults)) continue;
      const assigned = ts.isPropertyAssignment(property) ? property.initializer : property.name;
      if (propertyName === "controllers") {
        defaults.controllers.push(...collectIdentifiers(assigned));
      }
      if (propertyName === "providers") {
        defaults.providers.push(...collectIdentifiers(assigned));
      }
      if (propertyName === "imports") {
        defaults.imports.push(...collectIdentifiers(assigned));
      }
      if (propertyName === "exports") {
        defaults.exports.push(...collectIdentifiers(assigned));
      }
    }
  }

  return {
    controllers: dedupe(defaults.controllers),
    providers: dedupe(defaults.providers),
    imports: dedupe(defaults.imports),
    exports: dedupe(defaults.exports),
  };
}

function collectIdentifiers(node: ts.Expression | ts.BindingName): string[] {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isPropertyAccessExpression(node)) return [node.name.text];
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements
      .map((item) =>
        ts.isIdentifier(item)
          ? item.text
          : ts.isPropertyAccessExpression(item)
            ? item.name.text
            : undefined,
      )
      .filter((value): value is string => Boolean(value));
  }
  return [];
}

function collectModuleMembership(context: AnalysisContext): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const source of context.program.getSourceFiles().filter((file) => !file.isDeclarationFile)) {
    const aliases = collectImportAliases(source);
    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue;
      const decorators = collectDecoratorNames(decoratorsOf(statement), aliases);
      if (!decorators.includes("Module")) continue;

      const metadata = collectModuleMetadata(statement, aliases);
      const moduleId = symbolId(
        "nest-module",
        relativeFromRoot(context, source.fileName) ?? context.relativePath,
        statement.name.text,
      );
      for (const child of [...metadata.controllers, ...metadata.providers]) {
        mapping.set(child, moduleId);
      }
    }
  }

  return mapping;
}

function collectClassUseGuards(classNode: ts.ClassDeclaration, aliases: ImportAliasMap): string[] {
  const names: string[] = [];
  for (const decorator of decoratorsOf(classNode)) {
    const expression = decorator.expression;
    const call = ts.isCallExpression(expression) ? expression : undefined;
    if (!call) continue;
    const name = resolveDecoratorName(expression, aliases);
    if (!name) continue;
    if (name !== "UseGuards") continue;
    for (const arg of call.arguments) {
      if (ts.isIdentifier(arg)) names.push(arg.text);
    }
  }
  return dedupe(names);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function combineRoutes(base: string, child: string): string {
  const segments = [base, child].map((value) => value.replace(/^\/+|\/+$/g, "")).filter(Boolean);
  return segments.length > 0 ? `/${segments.join("/")}` : "/";
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
      classification: confidence === 1 ? "framework-derived" : "heuristic",
      analyzer: "nestjs",
    },
  };
}

function relativeFromRoot(context: AnalysisContext, absolutePath: string): string | undefined {
  const normalized = absolutePath.replace(/\\/g, "/");
  const root = context.root.replace(/\\/g, "/");
  if (normalized !== root && !normalized.startsWith(`${root}/`)) return undefined;
  const remainder = normalized.slice(root.length);
  return remainder.startsWith("/") ? remainder.slice(1) : remainder;
}
