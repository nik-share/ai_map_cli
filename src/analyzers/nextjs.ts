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
  getDeclarationName,
  getTopLevelDefaultExportDeclaration,
  hasAnyTopLevelExport,
  makeSymbol,
  nodeLine,
  nodeRange,
} from "./helpers.js";

const ROUTE_GROUP_SEGMENT = /^\(.*\)$/;
const ROUTE_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const APP_FILES_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

type NextRouter = "app" | "pages";
type NextKind = "page" | "layout" | "route" | "special";

interface ParsedNextRoute {
  router: NextRouter;
  kind: NextKind;
  route: string;
  name: string;
  params: string[];
}

export class NextJsAnalyzer implements FrameworkAnalyzer {
  readonly name = "nextjs";
  readonly version = "0.1.0-experimental";

  supports(context: AnalysisContext): boolean {
    if (!APP_FILES_EXTENSIONS.has(path.extname(context.relativePath).toLowerCase())) return false;
    return (
      context.relativePath.startsWith("app/") ||
      context.relativePath.startsWith("pages/") ||
      context.relativePath === "middleware.ts"
    );
  }

  analyze(context: AnalysisContext): AnalysisContribution {
    const sourceFile = context.sourceFile;
    const route = parseNextRoute(context.relativePath);
    const defaultExportNode = getTopLevelDefaultExportDeclaration(sourceFile);
    const hasTopLevelExport = hasAnyTopLevelExport(sourceFile);
    const symbols: AnalysisContribution["symbols"] = [];
    const relations: RelationRecord[] = [];

    if (!route) {
      return { symbols, relations, frameworks: ["nextjs"] };
    }

    if (route.kind === "page") {
      const pageFacts = pageFactsForRoute(context, route);
      const symbol = makeSymbol(context, defaultExportNode ?? sourceFile, "next-page", {
        name: defaultExportNode ? getDeclarationName(defaultExportNode, route.name) : route.name,
        defaultExport: Boolean(defaultExportNode),
        exported: hasTopLevelExport,
        facts: pageFacts,
      });
      symbols.push(symbol);

      if (route.router === "app") {
        for (const layout of collectContainingAppLayouts(context.relativePath, context)) {
          relations.push(
            makeRelation(
              symbol.id,
              "uses-layout",
              symbolId("next-layout", layout, "layout"),
              context,
              sourceFile,
              1,
              "app route layout chain",
            ),
          );
        }
      }
      return { symbols, relations, frameworks: ["nextjs"] };
    }

    if (route.kind === "layout") {
      symbols.push(
        makeSymbol(context, defaultExportNode ?? sourceFile, "next-layout", {
          exported: hasTopLevelExport,
          defaultExport: Boolean(defaultExportNode),
          name: "layout",
          facts: {
            router: route.router,
            route: route.route,
            runtime: runtimeFromSource(sourceFile),
            params: route.params.join(","),
            metadata: compactText(collectMetadataMarkers(sourceFile).join(",")),
          },
        }),
      );
      return { symbols, relations, frameworks: ["nextjs"] };
    }

    if (route.kind === "route") {
      const methods = collectRouteMethods(sourceFile);
      symbols.push(
        makeSymbol(context, sourceFile, "next-route-handler", {
          exported: hasTopLevelExport,
          name: "route-handler",
          facts: {
            router: route.router,
            route: route.route,
            methods,
            runtime: runtimeFromSource(sourceFile),
            metadata: compactText(collectMetadataMarkers(sourceFile).join(",")),
          },
        }),
      );
      return { symbols, relations, frameworks: ["nextjs"] };
    }

    symbols.push(
      makeSymbol(context, sourceFile, "next-special-file", {
        exported: hasTopLevelExport,
        name: route.name,
        facts: {
          router: route.router,
          route: route.route,
          runtime: runtimeFromSource(sourceFile),
        },
      }),
    );

    return { symbols, relations, frameworks: ["nextjs"] };
  }
}

export default NextJsAnalyzer;

function parseNextRoute(relativePath: string): ParsedNextRoute | undefined {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized.startsWith("app/") && !normalized.startsWith("pages/")) return undefined;

  const router: NextRouter = normalized.startsWith("app/") ? "app" : "pages";
  const segments = normalized.split("/").filter(Boolean);
  const fileName = segments.at(-1);
  if (!fileName) return undefined;
  const fileBase = fileName.replace(/\.(ts|tsx|js|jsx)$/, "");

  if (router === "app") {
    const routeSegments = segments.slice(1, -1);
    const baseRoute = buildRouteFromSegments(routeSegments);

    if (fileBase === "layout") {
      return {
        router,
        kind: "layout",
        route: baseRoute,
        name: "layout",
        params: dynamicSegmentNames(routeSegments),
      };
    }

    if (fileBase === "page") {
      return {
        router,
        kind: "page",
        route: baseRoute,
        name: baseRoute.split("/")[baseRoute.split("/").length - 1] || "page",
        params: dynamicSegmentNames(routeSegments),
      };
    }

    if (fileBase === "route") {
      return {
        router,
        kind: "route",
        route: baseRoute,
        name: "route",
        params: dynamicSegmentNames(routeSegments),
      };
    }

    if (fileBase.startsWith("_")) {
      return {
        router,
        kind: "special",
        route: "/_" + fileBase.replace(/^_/, ""),
        name: fileName,
        params: [],
      };
    }

    return undefined;
  }

  const pageSegments = segments.slice(1);
  if (pageSegments.length === 0) return undefined;
  const isApi = pageSegments[0] === "api";
  const routeSegments = pageSegments.slice(0, pageSegments.length - 1);
  const route = `/${buildRouteFromSegments([...routeSegments, fileBase === "index" ? "" : fileBase].filter(Boolean)).replace(/^\//, "")}`;

  return {
    router,
    kind: isApi ? "route" : "page",
    route,
    name: route.split("/")[route.split("/").length - 1] || "page",
    params: [...routeSegments, fileBase].filter(isDynamicSegment).map(stripDynamicMarkers),
  };
}

function pageFactsForRoute(
  context: AnalysisContext,
  route: ParsedNextRoute,
): Record<string, string> {
  const markers = compactText(collectMetadataMarkers(context.sourceFile).join(","));
  return {
    router: route.router,
    route: route.route,
    params: route.params.join(","),
    runtime: runtimeFromSource(context.sourceFile),
    metadata: markers,
  };
}

function collectMetadataMarkers(sourceFile: ts.SourceFile): string[] {
  const facts: string[] = [];
  const addMarker = (name: string): void => {
    if (name === "generateMetadata") facts.push("generatemetadata");
    if (name === "getServerSideProps") facts.push("getserversideprops");
    if (name === "getStaticProps") facts.push("getstaticprops");
    if (name === "getStaticPaths") facts.push("getstaticpaths");
  };

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      addMarker(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) addMarker(declaration.name.text);
      }
    }
  }
  return [...new Set(facts)];
}

function collectRouteMethods(sourceFile: ts.SourceFile): string {
  const methods = new Set<string>();

  const addFromDeclaration = (name: string | undefined): void => {
    if (!name) return;
    const normalized = name.toUpperCase();
    if (ROUTE_METHODS.has(normalized)) methods.add(normalized.toLowerCase());
  };

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      addFromDeclaration(statement.name.text);
      continue;
    }

    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (isFunctionLikeExpression(declaration.initializer)) {
        addFromDeclaration(declaration.name.text);
      }
    }
  }

  return [...methods].join(",");
}

function isFunctionLikeExpression(
  node: ts.Expression | undefined,
): node is ts.ArrowFunction | ts.FunctionExpression {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function runtimeFromSource(sourceFile: ts.SourceFile): string {
  if (hasDirective(sourceFile, "use client")) return "client";
  if (hasDirective(sourceFile, "use server")) return "server";
  return "server";
}

function hasDirective(sourceFile: ts.SourceFile, directive: string): boolean {
  return sourceFile.statements
    .slice(0, 8)
    .some(
      (statement) =>
        ts.isExpressionStatement(statement) &&
        ts.isStringLiteral(statement.expression) &&
        statement.expression.text === directive,
    );
}

function collectContainingAppLayouts(relativePath: string, context: AnalysisContext): string[] {
  const fileSegments = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (fileSegments[0] !== "app") return [];

  const layoutSegments = fileSegments.slice(1, -1);
  const candidates: string[] = [];
  for (let index = 0; index <= layoutSegments.length; index += 1) {
    const prefix = layoutSegments.slice(0, index);
    const candidateWithoutExt = ["app", ...prefix, "layout"].join("/");
    const tsx = `${candidateWithoutExt}.tsx`;
    const ts = `${candidateWithoutExt}.ts`;
    if (programContainsSourceFile(context, tsx)) candidates.push(tsx);
    if (programContainsSourceFile(context, ts)) candidates.push(ts);
  }
  return candidates;
}

function programContainsSourceFile(context: AnalysisContext, candidateRelative: string): boolean {
  const absolute = path.resolve(context.root, candidateRelative);
  return context.program
    .getSourceFiles()
    .some((source) => normalizeSourcePath(source.fileName) === normalizeSourcePath(absolute));
}

function normalizeSourcePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function isDynamicSegment(segment: string): boolean {
  return /^\[{1,2}\.?.*\]$/.test(segment);
}

function dynamicSegmentNames(segments: string[]): string[] {
  return segments.filter(isDynamicSegment).map(stripDynamicMarkers);
}

function stripDynamicMarkers(segment: string): string {
  return segment.replace(/^\[\[?\.*/g, "").replace(/\]$/g, "");
}

function buildRouteFromSegments(segments: string[]): string {
  const cleaned = segments
    .filter(Boolean)
    .filter((segment) => !ROUTE_GROUP_SEGMENT.test(segment))
    .map((segment) => segment);
  return `/${cleaned.length > 0 ? cleaned.join("/") : ""}`;
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
      analyzer: "nextjs",
    },
  };
}
