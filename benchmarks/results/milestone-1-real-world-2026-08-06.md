# Milestone 1 real-world validation — 2026-08-06

## Status

Milestone 1 closes the alpha's working-directory-dependent semantic behavior and introduces deterministic per-`tsconfig` compiler units. The correctness and determinism contract passed on all three representative repositories. Unchanged-scan performance improved substantially, while the strict fresh-scan time and peak-RSS gates did not pass; the measured blocker and lifecycle investigation are recorded below.

- Base commit: `4e137c9` (`feat: establish ai-code-map alpha`)
- Package version: `0.1.0` (not published)
- Persisted schema: `2`
- Analyzer version: `0.2.0`
- Node.js: `v22.16.0`
- pnpm: `11.13.1`
- Platform: macOS `26.5.2`, arm64

All authoritative generated maps were written below an isolated temporary output directory. The
three target repositories were Git-clean before and after validation. No dependencies were
installed and no files were written in those repositories.

## Protocol

For each repository, the built production CLI was run with the same explicit `--root`, `--config`, and `--output` values:

1. run a fresh target-CWD scan under macOS `/usr/bin/time -l`;
2. hash every managed artifact;
3. run unchanged scans from the scanner repository, target repository, and unrelated temporary directory;
4. require every unchanged scan to report `wrote: false` and an empty change set;
5. require every managed artifact hash to remain identical;
6. run `check --json` and require `current: true`;
7. record counts, artifact bytes, compiler-unit ownership, relation provenance, fresh time, median of the three unchanged scans, and isolated peak RSS.

After the unchanged-scan optimization was introduced, a second protocol forced a full analysis independently from the target repository, the scanner repository, and an unrelated temporary directory. Before each run, it removed only that repository's temporary output directory, then used identical absolute `--root`, `--config`, and `--output` arguments. All seven managed artifacts were compared byte-for-byte, and an immediate unchanged scan after each fresh run had to report `wrote: false`.

The fresh and warm times are internal CLI elapsed times. “Warm” still starts a new Node.js process, but a current default map now reuses the fully validated persisted records after the shared freshness check instead of rebuilding compiler state. Stale inputs, invalid/missing artifacts, and custom analysis components fall through to full analysis. Filesystem caches were not flushed.

## Correctness and freshness result

| Project         | Three fresh CWD analyses | Immediate no-op after each | `check` | External Git status |
| --------------- | ------------------------ | -------------------------- | ------- | ------------------- |
| `shade-factory` | byte-identical           | all `wrote: false`         | current | clean               |
| `crm-back`      | byte-identical           | all `wrote: false`         | current | clean               |
| `crm-front`     | byte-identical           | all `wrote: false`         | current | clean               |

### Fresh full-analysis CWD comparison

| Project         | Target CWD | Scanner CWD | Unrelated CWD | Files | Symbols | Relations | Diagnostics |
| --------------- | ---------: | ----------: | ------------: | ----: | ------: | --------: | ----------: |
| `shade-factory` |    8.073 s |     7.157 s |       7.076 s |   524 |   1,474 |    72,054 |          14 |
| `crm-back`      |    7.355 s |     6.479 s |       6.664 s |   209 |   1,912 |    30,746 |           0 |
| `crm-front`     |    6.102 s |     5.850 s |       5.913 s |   786 |   3,055 |    49,331 |         349 |

These are nine independent full analyses, not persisted-map reuse: the output directory was absent before every fresh invocation. For each repository, `overview.md`, `manifest.json`, `project.json`, `files.jsonl`, `symbols.jsonl`, `relations.jsonl`, and `diagnostics.json` were identical across all three working directories.

The focused fixture suite additionally changes extended, referenced, and sibling configs, root and workspace dependency ranges, and a lockfile independently. Each mutation makes `check` stale without a source change, and each rescan restores current status.

## Verification matrix

| Command                                            | Result                              |
| -------------------------------------------------- | ----------------------------------- |
| `pnpm test`                                        | 27 passed, 3 optional tests skipped |
| `AI_CODE_MAP_TEST_OPTIONAL_FRAMEWORKS=1 pnpm test` | 30 passed                           |
| `pnpm typecheck`                                   | passed                              |
| `pnpm lint`                                        | passed                              |
| `pnpm format:check`                                | passed                              |
| `pnpm schema:check`                                | passed                              |
| `pnpm build`                                       | passed                              |
| `pnpm pack --dry-run`                              | passed                              |

The independent Milestone 1 validator owns nine integration scenarios covering the requested public behavior and approved the milestone after reviewing the forced-fresh CWD evidence. The package was built and dry-run packed only; it was not published.

## Before/after performance and size

| Project         | Fresh baseline | Fresh M1 |  Delta | Warm baseline | Warm M1 |  Delta | RSS baseline |    RSS M1 |  Delta |  RSS gate |
| --------------- | -------------: | -------: | -----: | ------------: | ------: | -----: | -----------: | --------: | -----: | --------: |
| `shade-factory` |         5.06 s |   8.09 s | +59.9% |        5.05 s |  0.52 s | -89.7% |    1,133 MiB | 1,293 MiB | +14.1% | 1,246 MiB |
| `crm-back`      |         3.61 s |   7.15 s | +98.1% |        3.76 s |  0.22 s | -94.2% |    1,312 MiB | 1,689 MiB | +28.8% | 1,443 MiB |
| `crm-front`     |         4.35 s |   6.16 s | +41.6% |        4.41 s |  0.46 s | -89.7% |      884 MiB |   991 MiB | +12.1% |   972 MiB |

All three fresh-scan regressions exceed the 15% investigation threshold. Warm scans are now materially faster than baseline. All three isolated fresh peak-RSS values exceed their baseline-plus-10% gates.

| Project         | Files | Symbols | Relations baseline | Relations M1 |   Delta | Diagnostics | Map baseline |    Map M1 |   Delta |
| --------------- | ----: | ------: | -----------------: | -----------: | ------: | ----------: | -----------: | --------: | ------: |
| `shade-factory` |   524 |   1,474 |             27,920 |       72,054 | +158.1% |          14 |    13.42 MiB | 31.14 MiB | +132.1% |
| `crm-back`      |   209 |   1,912 |             19,852 |       30,746 |  +54.9% |           0 |     8.99 MiB | 13.07 MiB |  +45.3% |
| `crm-front`     |   786 |   3,055 |             31,199 |       49,331 |  +58.1% |         349 |    15.75 MiB | 22.66 MiB |  +43.9% |

File, symbol, and diagnostic counts are unchanged. The diagnostic sets remain the known unresolved CSS imports on the two frontend projects.

## Compiler-unit ownership

| Project         | Compiler unit        | Owned files |
| --------------- | -------------------- | ----------: |
| `shade-factory` | `tsconfig.json`      |         518 |
|                 | explicit fallback    |           6 |
| `crm-back`      | `tsconfig.json`      |         173 |
|                 | explicit fallback    |          36 |
| `crm-front`     | `tsconfig.json`      |         783 |
|                 | `tsconfig.node.json` |           1 |
|                 | explicit fallback    |           2 |

Every indexed file has exactly one persisted `compilerUnit`. Configs are eligible only when TypeScript's parsed `fileNames` includes the file. Precedence is the deepest shared workspace/package boundary, then the deepest config-directory ancestor, then normalized lexical config path. Files with no eligible config use the one root-anchored fallback unit.

## Relation-count explanation

Fewer relations are not assumed to be better. The baseline used one approximate Program and leaked caller-CWD ambient types. Milestone 1 uses the owning config's `configFilePath`, options, local type roots, module resolver, and complete parsed root set. Correct checker resolution therefore confirms substantially more calls and references.

| Project         |  Exact | Framework-derived | Heuristic | Derived inverse |
| --------------- | -----: | ----------------: | --------: | --------------: |
| `shade-factory` | 42,169 |               389 |       244 |          29,252 |
| `crm-back`      | 19,649 |                 0 |         5 |          11,092 |
| `crm-front`     | 31,678 |               708 |       351 |          16,594 |

For `shade-factory`, the old scanner-CWD comparison produced 62,234 relations; Milestone 1 produces 72,054 with only 244 heuristic records. For `crm-back`, 6,698 relations originate in its 36 fallback-owned files and 24,048 in configured files. This is a correctness-driven graph expansion, not duplicate file or symbol persistence; the fixture and schema validation reject duplicate records.

## Program lifecycle investigation

The first implementation processed compiler units sequentially inside one async coordinator scope. On `crm-back`, changing unit order did not help: configured-first measured 2,222,112,768 bytes peak RSS. Moving each Program/TypeChecker into a dedicated helper that returns only normalized facts measured 1,777,221,632 bytes in the isolated A/B run and 1,771,536,384 bytes in the authoritative final protocol. This boundary is retained.

The remaining blocker has three measured contributors:

- each configured Program uses the complete TypeScript-parsed project root set, including files needed for project semantics even when they are not persisted scanner outputs;
- fallback-owned files require a separate compiler environment and can transitively load a substantial dependency graph;
- corrected semantic resolution produces 55–158% more persisted relations, including their existing canonical `used-by` inverses.

Dropping parsed config files, ambient types, exact relations, or fallback semantics would make the scanner cheaper by weakening the requested correctness contract. An experimental forced-GC API was evaluated and rejected as an unstable production dependency. Current default scans instead reuse a complete validated map without invoking parsers, resolvers, or analyzers; focused tests prove that stale inputs, bad companion artifacts, and custom component identities cannot take that path. The next fresh-scan resource pass needs heap profiles and a supported isolation/reuse design rather than fact suppression.

## Representative React records

The `crm-front` output includes the following exact persisted records (abridged only by omitting unrelated fields):

```json
{
  "compilerUnit": "compiler-unit:tsconfig.json",
  "id": "file:src/App.tsx",
  "path": "src/App.tsx",
  "schemaVersion": 2
}
```

```json
{
  "facts": {
    "effects": "useeffect:[initializeAuth]",
    "hooks": "useauth",
    "state": "initialloading,setinitialloading"
  },
  "file": "src/App.tsx",
  "id": "component:src/App.tsx#App",
  "kind": "react-component",
  "signature": "(): JSX.Element"
}
```

```json
{
  "from": "component:src/App.tsx#App",
  "type": "renders",
  "to": "component:src/components/auth/LoginForm.tsx#LoginForm",
  "confidence": 0.95,
  "origin": {
    "analyzer": "react",
    "classification": "framework-derived",
    "explanation": "JSX render",
    "file": "src/App.tsx",
    "line": 219
  }
}
```

The same map has a framework-derived `uses-hook` relation from `App` to `hook:src/hooks/auth/useAuth.ts#useAuth` at `src/App.tsx:88`.

## Known limitations

- Project-reference edges are discovered and fingerprinted, while scan Programs resolve source imports directly instead of requiring previously emitted declaration files.
- Package-manager symlinks whose real targets escape the selected root are intentionally unreadable to the bounded compiler host.
- The fallback unit uses conservative NodeNext/JSX defaults; no config can supply more specific intent for those files.
- New processes rebuild compiler state; there is no watch/builder cache.
- Next.js and NestJS rule packs remain experimental and default-off. Tree-sitter/ast-grep remains development-only.
- Resource measurements are one macOS arm64 machine and include Node.js, TypeScript, normalized facts, and serialization buffers.

## Recommended next milestone

Run a focused resource-stabilization milestone before promoting Next.js, NestJS, Tree-sitter, or MCP work: capture per-unit heap profiles, evaluate supported compiler-process isolation or safe compiler-state reuse, and reduce rebuild/serialization overhead without removing exact facts. Re-run these same three targets and close the RSS/time gates before broadening framework scope.
