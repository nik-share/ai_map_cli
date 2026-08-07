# Real-world alpha baseline — 2026-08-06

## Status

This document records the first representative-project baseline for AI Code Map.

- Commit: `4e137c9` (`feat: establish ai-code-map alpha`)
- Tag: `v0.1.0-alpha.1`
- Package version: `0.1.0`
- Node.js: `v22.16.0`
- pnpm: `11.13.1`
- Platform: macOS `26.5.2`, arm64

The scanned repositories were treated as read-only. All map outputs and package-consumer files were written below a temporary directory. Git status was clean for all three repositories before and after the evaluation.

## Executive result

The alpha successfully scanned three real projects containing 1,519 indexed source files in total. Every fresh scan, repeat scan, `check`, and sampled `show` command completed without a critical parse error. Repeated scans in the same target-root invocation environment were deterministic and did not rewrite artifacts. A 30-relation evidence spot-check found no incorrect source location or target among the selected React, call, and construction relations.

The evaluation also found four release-blocking or product-critical gaps:

1. semantic results depend on the process working directory because ambient TypeScript type roots are not anchored to the selected project root;
2. only one root `tsconfig` is used, even when another config owns an indexed file;
3. the current unbounded `show` response is usually larger than the source file it is intended to replace;
4. peak RSS was approximately 884–1,312 MiB on these projects.

The results support implementing the per-`tsconfig` semantic-unit milestone next. That milestone must include working-directory independence and memory gates. A bounded context/query representation is required before claiming token savings.

## Projects

| Project         | Primary shape                    | Source inventory | Indexed files | Relevant configuration                                   |
| --------------- | -------------------------------- | ---------------: | ------------: | -------------------------------------------------------- |
| `shade-factory` | Next.js 16, React 19, TypeScript |              575 |           524 | root `tsconfig`; two excluded nested TypeScript projects |
| `crm-back`      | Node.js and TypeScript backend   |              209 |           209 | one root `tsconfig`                                      |
| `crm-front`     | Vite, React 18, TypeScript       |              786 |           786 | root `tsconfig` plus `tsconfig.node.json`                |

The source inventory counts eligible JS/TS extensions visible to `rg`. The indexed count follows the scanner's configured discovery rules, so the two values are not expected to be identical.

## Protocol

For each project:

1. run the built production CLI from the target project root against a fresh output directory;
2. run three unchanged scans against the same map and record the median internal elapsed time;
3. verify every repeat reports `wrote: false` and no source changes;
4. run `check --json` and require `current: true`;
5. run `show --json` for a high-degree and a representative-degree symbol;
6. measure maximum resident set size with macOS `/usr/bin/time -l` in a separate fresh process;
7. summarize artifact sizes, symbol kinds, relation types, classifications, and diagnostics;
8. verify 30 deterministic evidence samples against their recorded source lines;
9. build a tarball, install it into a clean temporary consumer, and scan a real project through the installed CLI.

“Fresh” means a new Node.js process and a missing output map. Filesystem and operating-system caches were not flushed. “Warm” means another new process with a current persisted map; it is not a long-lived TypeScript or Tree-sitter cache.

## Scan results

| Project         | Fresh scan | Warm median |  Peak RSS | Files | Symbols | Relations | Diagnostics |
| --------------- | ---------: | ----------: | --------: | ----: | ------: | --------: | ----------: |
| `shade-factory` |     5.06 s |      5.05 s | 1,133 MiB |   524 |   1,474 |    27,920 |          14 |
| `crm-back`      |     3.61 s |      3.76 s | 1,312 MiB |   209 |   1,912 |    19,852 |           0 |
| `crm-front`     |     4.35 s |      4.41 s |   884 MiB |   786 |   3,055 |    31,199 |         349 |

All scans returned exit code `0` and `criticalParseErrors: false`. All three maps were reported current immediately after the scan. Three unchanged repeats per project produced identical counts, empty change sets, and `wrote: false`.

Warm scans currently provide little speedup because the CLI rebuilds compiler and in-memory analysis state in every process. The persisted map prevents writes but is not yet an incremental semantic cache.

## Artifact size

| Project         | Indexed source | Canonical map | Map/source | `symbols.jsonl`/source | Largest artifact              |
| --------------- | -------------: | ------------: | ---------: | ---------------------: | ----------------------------- |
| `shade-factory` |       2.52 MiB |     13.42 MiB |      5.32× |                  0.27× | `relations.jsonl` (11.92 MiB) |
| `crm-back`      |       1.68 MiB |      8.99 MiB |      5.35× |                  0.52× | `relations.jsonl` (7.68 MiB)  |
| `crm-front`     |       2.81 MiB |     15.75 MiB |      5.60× |                  0.55× | `relations.jsonl` (12.81 MiB) |

The compact symbol facts are smaller than source, but the fully materialized relation graph makes the complete map much larger. The map is therefore an index to query, not a file to place wholesale into an AI context.

No byte-identical duplicate relation records were found. Much of the volume is still derivable or redundant for storage purposes:

- `used-by` is the materialized inverse of forward relations and accounts for 24–28% of relations;
- calls, references, and their source evidence create many repeated endpoint pairs at different locations;
- `shade-factory` alone contains 7,200 derived `used-by` records.

Future query indexes may calculate inverse edges without persisting every copy in the canonical context format.

## Diagnostics

Every diagnostic across all three projects was an unresolved CSS import:

| Project         | Total | CSS or CSS Module imports | Non-asset unresolved imports |
| --------------- | ----: | ------------------------: | ---------------------------: |
| `shade-factory` |    14 |                        14 |                            0 |
| `crm-back`      |     0 |                         0 |                            0 |
| `crm-front`     |   349 |                       349 |                            0 |

CSS imports are expected in bundler projects and should not consume the same warning channel as unresolved JS/TS modules. They should be classified as ignored/non-code assets or handled by a configurable asset-extension policy.

## Relation evidence spot-check

Thirty non-test relations were inspected at their recorded source line:

- `renders` samples pointed to the expected JSX component usage;
- `uses-hook` samples pointed to the expected hook call;
- `calls` samples pointed to the expected invocation;
- `instantiates` samples pointed to the expected `new` expression.

All 30 inspected samples matched their evidence line and target. This is a useful sanity check, not a statistically valid precision/recall score. A labeled evaluation corpus is still required.

## Current `show` context size

The token figures below use `characters / 4` as a deliberately rough proxy. They are not tokenizer measurements.

| Project         | Symbol                                      | Degree |   Source proxy | Current `show` proxy |
| --------------- | ------------------------------------------- | -----: | -------------: | -------------------: |
| `shade-factory` | `Button`                                    |    159 |    ~551 tokens |       ~29,020 tokens |
| `shade-factory` | `GoogleSearchInput`                         |     15 |    ~588 tokens |        ~3,354 tokens |
| `crm-back`      | `ReportService`                             |    124 | ~65,185 tokens |       ~30,626 tokens |
| `crm-back`      | `InactivePartnersDashboardPaginatedFilters` |      7 |    ~510 tokens |        ~2,061 tokens |
| `crm-front`     | `ClientListTable`                           |    154 |  ~4,623 tokens |       ~29,357 tokens |
| `crm-front`     | `RevenueExportButton`                       |     19 |  ~5,019 tokens |        ~6,066 tokens |

Only the very large `ReportService` file was smaller through the current `show` representation. `show` returns the full file record plus every inbound and outbound relation, so highly reused components become especially expensive.

This baseline does **not** demonstrate token savings through the current public interface.

## Simulated bounded context

To test the product hypothesis without changing production code, the same symbols were rendered as:

- the normalized symbol record;
- no full file record;
- at most 20 prioritized minimal relations;
- a count of omitted relations.

| Project         | Symbol                                      | Simulated compact proxy | Omitted relations |
| --------------- | ------------------------------------------- | ----------------------: | ----------------: |
| `shade-factory` | `Button`                                    |           ~1,181 tokens |               139 |
| `shade-factory` | `GoogleSearchInput`                         |             ~764 tokens |                 0 |
| `crm-back`      | `ReportService`                             |           ~1,199 tokens |               104 |
| `crm-back`      | `InactivePartnersDashboardPaginatedFilters` |             ~457 tokens |                 0 |
| `crm-front`     | `ClientListTable`                           |           ~1,273 tokens |               134 |
| `crm-front`     | `RevenueExportButton`                       |           ~1,134 tokens |                 0 |

The simulation is not a shipped feature and does not prove task-level usefulness. It does show that normalized facts can be compact when relation selection and representation are bounded. Large files and components benefit substantially; very small source files may remain cheaper to read directly.

The eventual context selector should be able to choose between source, map facts, or both instead of assuming the map is always smaller.

## Semantic-environment defect

The same source hashes, analyzer versions, selected `--root`, and TypeScript version produced different maps depending on the process working directory:

| Project         | Scanner repository cwd | Target project cwd | Difference |
| --------------- | ---------------------: | -----------------: | ---------: |
| `shade-factory` |                 62,234 |             27,920 |     34,314 |
| `crm-back`      |                 20,248 |             19,852 |        396 |
| `crm-front`     |                 31,205 |             31,199 |          6 |

For `shade-factory`, the scanner-directory run added 17,156 `calls`, 17,157 derived `used-by` relations, and one construction relation. Most of the additional calls were heuristic, not exact. For `crm-back`, the 396-record difference consists of 198 `calls` relations and their 198 derived inverses.

The compiler program loaded ambient types from the process working directory. For example, the `crm-back` comparison loaded different Node type packages:

- scanner directory: `@types/node@22.20.1`;
- target directory: `@types/node@22.19.19`.

`--root` must fully determine the semantic environment. The TypeScript compiler host/current directory and type-root discovery must be anchored to the selected compiler unit, never the scanner installation directory or caller's current directory.

This invariant needs an integration test that scans the same target from two unrelated working directories and requires byte-identical semantic artifacts.

## Multi-config observations

- `crm-front` indexes `vite.config.js`, but only its root `tsconfig.json` is loaded; `tsconfig.node.json` is ignored.
- `shade-factory` has root, `sku-import`, and `lab-to-hex` TypeScript configurations. The nested projects are excluded by the root config and are not represented as compiler units.
- current project metadata records one selected root `tsconfig`, not the config owning each file.

These are concrete real-project examples for the per-`tsconfig` semantic-unit milestone.

## Next.js observation

`shade-factory` is correctly detected as a Next.js project, but explicitly enabling the experimental `NextJsAnalyzer` produced zero Next-specific symbols. The project uses `src/app/**`, while the analyzer currently recognizes only root `app/**` and `pages/**` paths.

Before enabling the analyzer by default, add real-project coverage for:

- `src/app` and `src/pages`;
- route groups and dynamic segments beneath `src`;
- layouts and route handlers in both supported roots.

## Package smoke test

- tarball build: passed;
- tarball size: 203,198 bytes;
- install into a clean temporary pnpm consumer: passed;
- `pnpm exec ai-code-map --help`: passed;
- installed CLI scan of `crm-back`: passed.

An invocation through an absolute `/tmp/.../node_modules/.bin/ai-code-map` path from another working directory returned exit code `0` without running because macOS resolves `/tmp` to `/private/tmp`, while the CLI entry guard compares unresolved `process.argv[1]` with `import.meta.url`. Normal `pnpm exec` worked. The entry guard should compare real paths or use a dedicated unconditional bin entry.

## Recommended next order

### P0 — semantic correctness

1. Anchor compiler host resolution to the selected project/compiler-unit root.
2. Guarantee identical results regardless of caller working directory or scanner installation location.
3. Discover per-`tsconfig` units, extended configs, and project references.
4. Assign each indexed file to a deterministic owning unit, with an explicit fallback unit.
5. Include every relevant config and analyzer version in freshness hashing.
6. Process or retain units with an explicit memory budget; do not keep every large Program alive accidentally.

### P0 — usable AI context

1. Add bounded relation limits and direction/type filters to symbol queries.
2. Provide a compact representation that omits the full file record unless requested.
3. Rank framework-derived/exact relations ahead of heuristic and inverse records.
4. Return truncation and omitted-count metadata.
5. Select source instead of map facts when the source is already smaller.

### P1

- classify static asset imports without unresolved-code warnings;
- support `src/app` and `src/pages` in the experimental Next.js analyzer;
- profile the source of the 884–1,312 MiB peak RSS;
- evaluate whether inverse relations belong in canonical storage or only in a query index;
- make the executable entry robust to symlinked/realpath aliases.

### Deferred

- Tree-sitter promotion;
- MCP exposure;
- watch mode;
- task-level token-saving claims;
- Next.js/NestJS default enablement.

The exact same real-project protocol should be rerun after the semantic-unit milestone. Only after a bounded query/context layer exists should the project run agent A/B tasks and claim token or planning improvements.

## Limitations of this baseline

- The repositories were not labeled for full precision/recall measurement.
- Token figures are character-count proxies, not model-specific tokenization.
- No task-level agent A/B evaluation was performed.
- RSS measurements include the entire Node.js and TypeScript process.
- Cold filesystem caches were not controlled.
- Only macOS arm64 was measured.
- The experimental Next.js analyzer was inspected only on `shade-factory`; NestJS was not relevant to the selected backend.
