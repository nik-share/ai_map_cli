export const SCHEMA_VERSION = 1 as const;
export const CONFIG_VERSION = 1 as const;
export const ANALYZER_VERSION = "0.1.0";
export const DEFAULT_SYNTAX_PARSER = "typescript-compiler-syntax";
export const DEFAULT_SEMANTIC_RESOLVER = "typescript-program";
export const DEFAULT_ANALYZER_NAMES = ["typescript-node", "react"] as const;

export const DEFAULT_OUTPUT = ".ai/code-map";
export const DEFAULT_INCLUDE = [
  "src/**/*",
  "app/**/*",
  "pages/**/*",
  "lib/**/*",
  "server/**/*",
  "*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
] as const;
export const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/.next/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.git/**",
  "**/.ai/**",
  "**/*.generated.*",
] as const;

export const MANAGED_ARTIFACTS = [
  "overview.md",
  "manifest.json",
  "project.json",
  "files.jsonl",
  "symbols.jsonl",
  "relations.jsonl",
  "diagnostics.json",
] as const;
