# Post-alpha execution roadmap

> Status: Milestones 1, 1.1, and the 1.1.1 correctness closure are implemented; the clean-commit
> official benchmark and resource go/no-go remain pending before Milestone 2.

This document turns the high-level backlog into an ordered, measurable delivery plan. `PROJECT.md`
remains the product and architecture source of truth. The
[reviewed real-world alpha baseline](../benchmarks/results/alpha-real-world-baseline-2026-08-06.md)
is the aggregate evidence behind the priorities below; raw runs remain local because they contain
machine paths and external-project filenames.

## Why this order

The alpha proved that the scanner can package, install, and build deterministic artifacts in a stable invocation environment. It did not yet prove the full product thesis.

Three gates remain, and they depend on one another:

1. The semantic map must be correct and independent of the caller's working directory.
2. The query result given to an AI must be bounded and smaller than indiscriminate source reading.
3. Task-level experiments must show that the bounded map improves retrieval or planning in practice.

Building MCP, watch mode, cloud features, or a natural-language command before these gates would expose an unstable foundation through more interfaces.

## Delivery sequence

| Order | Milestone                           | Product question answered                                           | Exit signal                                                                       |
| ----: | ----------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
|     1 | Semantic correctness                | Does the same project always produce the same correct semantic map? | CWD-independent, per-config results pass unit and real-repo gates                 |
|   1.1 | Correctness and freshness hardening | Can persisted semantic evidence be trusted and safely reused?       | Complete input closure, artifact integrity, provenance, and relation gates pass   |
|     2 | Bounded context and query           | Can an agent retrieve useful facts within a strict budget?          | Compact output is bounded, ranked, explicit about omissions                       |
|     3 | Real-world regression baseline      | Did correctness and context work improve the measured alpha?        | Reproducible comparison report on the same three repositories                     |
|     4 | Task-level AI evaluation            | Does the map save tokens/time without harming plan quality?         | Controlled A/B results across a labeled task set                                  |
|     5 | Product and integration expansion   | Which interface should carry the proven capability?                 | Evidence-based choice of MCP, watch mode, framework work, and commercial features |

## Milestone 1 — semantic correctness

Priority: **P0**.

### Outcome

`--root` and the discovered TypeScript configuration graph completely determine the semantic environment. The process working directory, scanner checkout, and global/ambient packages outside the selected project cannot change canonical results.

Every indexed TypeScript or JavaScript file is analyzed exactly once under a deterministic owning compiler unit. Project references, extended configurations, workspace boundaries, and uncovered files are handled explicitly rather than being flattened into one accidental `Program`.

### Behavioral contract

#### 1. Working-directory independence

- Identical sources, configuration, CLI arguments, package state, and analyzer versions produce byte-identical canonical artifacts when invoked from unrelated working directories.
- A second unchanged scan reports an empty change set and `wrote: false`.
- Compiler hosts and module/type resolution are anchored to the selected compiler unit, never to `process.cwd()` or the scanner installation directory.
- Stored paths and diagnostics remain project-relative and do not leak absolute paths.

#### 2. Compiler configuration graph

- Discover applicable `tsconfig.json`, `jsconfig.json`, bounded `tsconfig.*.json` candidates, workspace configs, transitive `extends`, and project `references` within the selected root.
- Parse configuration through the TypeScript API; do not execute project files or dynamically load JavaScript configuration.
- Respect each parsed config's `files`, `include`, `exclude`, compiler options, base URL, paths, JavaScript policy, and project references.
- Reject or diagnose config/reference traversal outside the selected real root.
- Treat solution-style configs as graph nodes even when they own no files directly.

#### 3. Deterministic file ownership

- Assign every indexed JS/TS file to one owning compiler unit.
- Prefer configs that actually include the file; define and document stable precedence for overlaps.
- Use a safe root-anchored fallback unit for indexed files not owned by any valid config.
- Analyze an owned file once even when several Programs can see it through imports or references.
- Preserve cross-unit symbol targets, imports, calls, references, and stable IDs after normalized contributions are merged.

#### 4. Freshness completeness

The freshness fingerprint must change when a semantic input changes, including:

- root, owning, referenced, or transitively extended TypeScript configs;
- relevant root/workspace package metadata and dependency versions/ranges;
- relevant workspace manifests and lockfiles;
- the normalized compiler-unit graph and ownership decisions;
- TypeScript, semantic resolver, syntax parser, analyzer, rule-pack, configuration, and schema versions.

An unchanged graph must keep the same fingerprint. Changing output location alone must not silently change semantic facts.

#### 5. Resource discipline

- Do not retain every large TypeScript `Program` and `TypeChecker` after its unit has been normalized when they are no longer needed.
- Make unit processing order deterministic.
- Record or document the chosen Program lifecycle and its cross-unit trade-offs.
- On the same machine and protocol, no representative repository may regress more than 10% above its alpha peak-RSS baseline without an explicit, documented decision.
- Scan time regressions above 15% require investigation and explanation; correctness takes priority over speed.

#### 6. Safety and compatibility

- Never execute scanned application code, config files, plugins, or package scripts.
- Preserve the public alpha CLI flow and existing default React/TypeScript analyzers.
- Preserve custom semantic-resolver compatibility where practical; if a contract must evolve, provide a compatibility path and document it.
- Keep Tree-sitter/ast-grep development-only during this milestone.
- Treat persisted schema changes explicitly: regenerate checked-in schemas, bump compatibility versions when required, and produce actionable rescan errors.

### Required acceptance scenarios

The permanent suite should contain the smallest non-redundant set of high-signal fixtures covering these distinct risks:

1. Scan one fixture from its own directory and two unrelated directories containing conflicting ambient types; canonical results are identical.
2. Two workspace packages use the same path-alias spelling for different local targets; each resolves to its own target.
3. An application references a library project; definitions and cross-project calls resolve without duplicate persisted files or symbols.
4. A root browser config and a sibling Node/tooling config own different files in the same package.
5. Overlapping configs choose the same documented owner independent of discovery order.
6. An indexed orphan file enters a fallback unit and remains analyzable.
7. Changing an extended or referenced config makes `check` stale; an unchanged rescan performs no write.
8. An out-of-root config reference or symlink is rejected or safely diagnosed without indexing outside content.

Each important test must identify a plausible faulty implementation it rejects. Tests should assert public API, CLI, and persisted behavior rather than private helper structure.

### Real-project gates

Run the established protocol, writing maps only to a temporary directory and leaving target repositories untouched:

| Project         | Alpha relations | Alpha peak RSS | Known configuration case                               |
| --------------- | --------------: | -------------: | ------------------------------------------------------ |
| `shade-factory` |          27,920 |      1,133 MiB | root config plus excluded nested TypeScript projects   |
| `crm-back`      |          19,852 |      1,312 MiB | ambient type resolution changed with caller CWD        |
| `crm-front`     |          31,199 |        884 MiB | root config plus a separate Node/tooling configuration |

Required results:

- target-root and scanner-root invocations produce identical canonical outputs;
- all repeated scans are current and report `wrote: false`;
- compiler-unit ownership is inspectable and explains the known multi-config cases;
- no new non-asset unresolved-import regression appears;
- peak RSS and elapsed time are compared with the alpha baseline;
- target repositories remain byte-for-byte and Git-status clean.

### Deliverables

- compiler-unit discovery, ownership, and semantic coordination implementation;
- normalized compiler-unit metadata in an appropriate public or diagnostic representation;
- freshness hashing for the complete semantic input graph;
- independent behavioral tests and updated test contract;
- schema, API, limitation, architecture, and artifact documentation updates as applicable;
- a before/after benchmark report using the existing protocol.

### Non-goals

- compact context selection or a natural-language task command;
- MCP, watch mode, cloud synchronization, authentication, billing, or telemetry;
- enabling experimental Next.js or NestJS analyzers by default;
- promoting Tree-sitter/ast-grep into the production scan path;
- embeddings, vector search, or an LLM inside deterministic map generation.

### Exit criteria

Milestone 1 is complete only when:

- all acceptance scenarios pass;
- `pnpm test` and optional framework tests pass;
- typecheck, lint, formatting, schema synchronization, build, and package smoke checks pass;
- the three real repositories pass the CWD-invariance and freshness checks;
- resource measurements and any regression are documented;
- an independent validator confirms behavior from this contract, not from the implementation.

## Milestone 1.1 — semantic correctness and freshness hardening

Priority: **P0, complete (2026-08-07)**.

Milestone 1.1 closed the correctness gaps found during the first compiler-unit rollout:

- freshness now records compiler-consumed in-root files, project/toolchain-scoped file/directory/readability probes, directory listings, symlink mappings, and exact consumed TypeScript library bytes, including unindexed imports and nested package metadata;
- default reuse validates the complete artifact set, cross-record invariants, companion byte hashes, a manifest integrity hash, and a stable built-in producer fingerprint;
- scan and check use the same raw-byte source hash;
- project-reference package imports can resolve to referenced source without prebuilt declarations or a test-only `paths` alias;
- indexed JavaScript excluded by configured `allowJs` policy receives deterministic fallback analysis and a portable diagnostic;
- compiler-unit namespaces, persisted paths, non-spoofable extension isolation, external call identities, React default-import renders, and relation occurrence identity are hardened;
- the schema was version 3 and older maps received an actionable rescan path.

Evidence:

- [behavioral contract](../tests/TEST_CONTRACT.md#milestone-11-semantic-correctness-and-freshness-hardening-contract)
- [real-world benchmark and Milestone 1 comparison](../benchmarks/results/milestone-1-1-real-world-2026-08-06.md)
- independent public-fixture regression coverage for relation provenance and occurrence identity

Warm scans remain 89.8–94.9% faster than fresh scans in the final recorded run. Correctness has measurable cost: all three targets crossed the fresh-time investigation threshold, and `crm-front` remains above the prior RSS gate. Those regressions are documented rather than traded for weaker freshness or evidence and remain an explicit input to Milestone 2 resource work.

## Milestone 1.1.1 — correctness closure and release-grade validation

Priority: **P0, implementation complete; provisional benchmark pending final run**.

This closure requires checker-identity import provenance, occurrence-preserving React evidence,
raw-byte artifact repair, canonical integrity helpers, redundant ownership validation, portable
alias/custom identifiers, root-level composite reference resolution, complete JavaScript fallback
diagnostics, and endpoint-honest unresolved audit grouping. Schema v4 adds `compilerUnit` and `lines`
to every manifest source entry and therefore requires a rescan.

The release benchmark now runs the packed `dist` CLI from target, packaged-scanner, and unrelated
working directories; requires byte-identical fresh outputs; records at least three fresh and warm
isolated samples; and reports median/range wall time, internal time, RSS, artifact/manifest sizes,
semantic-input counts, relation-quality groupings, package checksum, exact commands, source snapshot,
and Git state. Dirty-tree results are provisional; an official clean-commit run requires explicit
commit authorization. The alpha RSS gates remain 1,246 MiB, 1,443 MiB, and 972 MiB respectively;
both `crm-back` and `crm-front` were above them in the prior M1.1 measurements, so go/no-go cannot be
implied by correctness alone.

The later dirty-tree packed-package run exceeded all three RSS gates. It is useful provisional
evidence, but it is deliberately not release approval; a clean-commit rerun and explicit memory
decision remain required.

Heuristic/unresolved relations keep inverse records for graph traversal but remain identifiable from
either endpoint and are excluded from future default compact context unless explicitly requested.

## Milestone 2 — bounded context and query

Priority: **P0**, after Milestone 1.

### Outcome

Expose a deterministic query layer that returns the smallest useful representation for a symbol or change surface. The full map remains an index and is never presented wholesale as AI context.

### Scope

- Add relation direction, type, confidence/classification, and limit filters.
- Add a compact symbol representation that omits the full file record by default.
- Rank exact and framework-derived forward relations ahead of heuristic and derived inverse records.
- Return `truncated`, per-category totals, and omitted counts so absence is never confused with completeness.
- Support a replaceable token estimator and a hard output budget.
- Compare the compact map representation with the relevant source slice and choose source when it is smaller.
- Keep task-language interpretation outside the deterministic core; the first query API should accept structured selectors and constraints.

### Initial quality gates

- Output never exceeds the requested budget except for a documented indivisible minimum record.
- Stable inputs and options produce byte-identical results.
- A 20-relation compact representation stays close to the successful baseline simulation rather than current unbounded `show` sizes.
- High-degree symbols do not crowd out their own signature, framework facts, or highest-confidence neighbors.
- Unknown, ambiguous, empty, and over-budget queries return explicit metadata and actionable errors.

### Non-goals

- claiming task-level token savings before Milestone 4;
- hiding truncation;
- making an LLM call from `scan` or the query engine;
- treating a character-count proxy as a real tokenizer measurement.

## Milestone 3 — real-world regression baseline

Priority: **P0**, immediately after bounded context exists.

### Outcome

Repeat the exact alpha protocol on the same repository revisions and publish a comparable report.

### Measurements

- indexed files, symbols, relations, diagnostics, and artifact sizes;
- fresh and repeated scan time;
- isolated-process peak RSS;
- CWD and installation-location invariance;
- config-unit ownership and freshness behavior;
- current `show`, compact query, selected source, and final chosen-context token counts using a real tokenizer;
- evidence spot-checks plus labeled precision/recall fixtures where available;
- package tarball installation and CLI smoke tests.

The report must separate regressions, intended semantic corrections, and representation/storage changes. Relation-count changes alone are not automatically improvements.

## Milestone 4 — task-level AI evaluation

Priority: **P1**, only after Milestones 1–3 pass.

### Hypothesis

For real maintenance tasks, map-first retrieval reduces context and navigation time while maintaining or improving relevant-file recall and plan quality.

### Experimental design

Build a labeled set of approximately 12–20 tasks across React, Next.js, Node.js, and NestJS projects. Include feature work, bug localization, impact analysis, and cross-layer changes. For each task, record the expected files/symbols and a review rubric before running agents.

Compare at least:

- **control:** normal repository search and source reading;
- **map-first:** bounded map query, followed by source verification;
- optionally, **file-tree summary:** a cheap non-semantic baseline.

Use the same model, instructions, tool access, repository revision, and context ceiling. Randomize task order where practical and keep evaluators blind to the arm.

### Primary metrics

- input and output tokens measured by the actual model/tokenizer;
- time to identify the first relevant file and time to final plan;
- relevant-file and relevant-symbol recall/precision;
- plan completeness, factual correctness, and unsupported claims under a fixed rubric;
- unnecessary files opened and repeated reads;
- failure rate when the map is incomplete or stale.

### Decision rule

Do not market a token-saving percentage from simulated records. A claim is justified only if the task-level study shows a consistent improvement and reports the model, task set, protocol, sample size, and variance.

## Milestone 5 — integrations and product expansion

Use Milestone 4 evidence to select the next surface rather than building every surface at once.

Likely order:

1. read-only stdio MCP tools over the stable structured query API;
2. watch mode and reusable TypeScript builder state for lower repeated-query latency;
3. Next.js `src/app` and `src/pages` correctness, then independently validated NestJS maturity;
4. optional local lexical/graph indexes when profiling shows that JSONL scans are the bottleneck;
5. CI impact reports and team/shared-map workflows;
6. commercial features such as hosted history, pull-request risk review, organization policies, collaboration, and usage analytics—with explicit privacy boundaries.

Tree-sitter remains a measured optimization candidate. Promote it only if repository-level experiments demonstrate a meaningful performance, recovery, or maintenance benefit after accounting for the still-required TypeScript semantic pass.

## Release checkpoints

- **Correctness candidate:** Milestone 1 complete and independently validated.
- **Useful-context candidate:** Milestones 1–3 complete with bounded query evidence.
- **Product-proof candidate:** Milestone 4 complete with reproducible task-level results.
- **Integration beta:** selected Milestone 5 interface built on the proven query contract.

Tags, publication, deployment, and commercial claims require an explicit maintainer decision; completion of a milestone does not perform them automatically.
