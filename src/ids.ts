import type { SymbolKind } from "./types.js";
import { normalizeStoredPath } from "./utils/path.js";

export function fileId(filePath: string): string {
  return `file:${normalizeStoredPath(filePath)}`;
}

export function symbolId(
  kind: SymbolKind,
  filePath: string,
  name: string,
  parent?: string,
): string {
  const prefix = symbolPrefix(kind);
  const qualifiedName = parent ? `${parent}.${name}` : name;
  return `${prefix}:${normalizeStoredPath(filePath)}#${qualifiedName}`;
}

export function externalId(moduleName: string, name = "default"): string {
  return `external:${moduleName}#${name}`;
}

export function routeId(method: string, route: string): string {
  return `route:${method.toUpperCase()}:${route || "/"}`;
}

function symbolPrefix(kind: SymbolKind): string {
  switch (kind) {
    case "react-component":
      return "component";
    case "react-hook":
      return "hook";
    case "next-page":
    case "next-layout":
    case "next-route-handler":
    case "next-special-file":
      return "next";
    case "nest-module":
    case "nest-controller":
    case "nest-provider":
    case "nest-guard":
    case "nest-interceptor":
    case "nest-pipe":
    case "nest-filter":
    case "nest-gateway":
      return "nest";
    case "type-alias":
      return "type";
    default:
      return kind;
  }
}
