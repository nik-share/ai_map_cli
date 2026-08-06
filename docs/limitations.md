# Known limitations and backlog

## In-scope alpha

- CLI commands are limited to `init`, `scan`, `check`, `show`.
- `scan` output is static analysis only; no code execution.
- No remote service, account linking, or telemetry is part of the alpha.
- Framework analyzers included by default are TypeScript/Node and React only.

## Next.js and NestJS

- Analyzer classes for Next.js and NestJS are exported and callable through the programmatic API.
- These analyzers are considered **experimental** and are **not enabled by default** in CLI.
- They are intentionally not part of the minimal default analyzer contract.

## Parser extensibility

- TypeScript compiler parser is authoritative in this alpha.
- The parser adapter interface supports custom adapters and fallback wrappers.
- A bounded `@ast-grep/napi` spike and fixture microbenchmark are present, but the adapter is development-only and is not enabled in production scans.
- Evidence and confidence still require explicit provenance in output and freshness contracts.

## Not yet implemented

- No global search/context query language in CLI.
- No impact/risk scoring commands.
- No source snippet persistence in public artifacts.
- No runtime evidence importer layer.
- No correct multi-`tsconfig`/project-reference analysis units yet; this is the recommended next milestone.

## Non-goals for this baseline

- No task-planner reasoning is provided by the map itself.
- No cloud CI/reporting extension is assumed from the local alpha artifacts.
