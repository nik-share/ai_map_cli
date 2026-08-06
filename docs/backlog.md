# Delivery backlog

`PROJECT.md` is the product source of truth. This page records implementation sequencing; it is not a promise that later capabilities exist in the alpha.

## Alpha contract

- Deterministic local TypeScript/JavaScript and React scanning.
- TypeScript compiler-authoritative semantic facts.
- Replaceable syntax and semantic boundaries with safe fallback.
- `init`, `scan`, `check`, and `show` only.
- Zod-owned configuration/persisted schemas, stable IDs, evidence, confidence, hashes, and freshness.
- Focused security, malformed-source, determinism, API, and CLI behavioral tests.

## Next milestone: Beta foundation

1. Split analysis into correct per-`tsconfig` units, including project references and monorepo package boundaries.
2. Mature and independently validate the existing experimental Next.js and NestJS analyzers before enabling either by default.
3. Run the parser evaluation corpus on representative repositories and supported CI platforms; decide whether ast-grep stays dev-only, becomes optional, or becomes a default candidate observer.
4. Add accuracy fixtures and precision/recall reporting for framework rule packs.
5. Only after map accuracy is stable, add rebuildable local query/impact indexes, watch mode, lexical search, and an official-SDK read-only stdio MCP adapter.

## Deferred adapters

- Graphology as a rebuildable in-memory index; JSONL remains canonical.
- MiniSearch for deterministic local lexical search.
- Chokidar for a long-lived watcher.
- Official MCP TypeScript SDK over local stdio.
- SCIP import/export and SARIF output.
- Safe optional importers for OpenAPI, GraphQL, coverage, CODEOWNERS, Storybook, and existing generated artifacts.

## Explicitly not core

- LLMs, embeddings, API keys, network calls, or telemetry in deterministic map generation.
- Natural-language CLI commands or `context "task" --budget`.
- Web UI, cloud service, billing, authentication, or deployment in this package.
- ts-morph, dependency-cruiser, or react-docgen as authoritative analyzers.
- Next.js private internals or NestJS runtime reflection.
- SQLite, Neo4j, or a vector database before profiling demonstrates a need.
- Dynamic execution/loading of scanned application modules or configuration.
