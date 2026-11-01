# Alpha.2 release validation — 2026-11-01

## Decision

**GO for the local `v0.1.0-alpha.2` release.** All three unchanged RSS gates passed.
Correctness, deterministic artifacts, freshness, and package execution passed. This record does
not claim publication to npm or GitHub, or completion of the later bounded-context milestones.

## Reproducibility

- Scanner code commit: `9a489a81333e03a7cd3f13ba4e5509daa0237e97`.
- Scanner checkout: clean and unchanged before and after the benchmark.
- Runtime: Node.js `v22.16.0`, pnpm `11.13.1`, Darwin `27.2.0`, arm64.
- Package: `ai-code-map-0.1.0-alpha.2.tgz`; SHA-256 `acc52e1e504cbafe414ad681bf28bbadb3ebc584eb816423f148aeaa889290d4`.
- The report is outside the published package file list. Its later documentation commit does not
  change the benchmarked package payload.
- Three fresh packaged-CLI processes per project ran from the target, extracted-package, and an
  unrelated temporary CWD, each with an absent output directory. Three new-process warm scans
  followed. The harness also checked freshness, loaded the packaged API, and checked Git state.
- Peak RSS is `/usr/bin/time -l` maximum resident set size for the whole process, including worker
  threads. No child-process accounting shortcut or heap cap is used.

| Target          | Source commit                              | Git state before / after |
| --------------- | ------------------------------------------ | ------------------------ |
| `shade-factory` | `ceebf6959753e274ec49828302fcf0c784df13a4` | clean / unchanged        |
| `crm-back`      | `9dc687b59c4cf1863658a594adcb94dc1eb9ee11` | clean / unchanged        |
| `crm-front`     | `82b2fcd4c44b226998e68590de1d41e718a2692f` | clean / unchanged        |

These August source commits were restored in temporary clones with copies of the currently
installed target dependencies. They are not claimed to reproduce the August dependency trees.
The benchmark package used the harness's disclosed local dependency-copy fallback because its
isolated offline install lacked cached tarballs. A separate consumer install of the exact tarball
used only runtime dependencies and passed the CLI/API smoke test. No target scripts ran.

Raw profiles, commands, exact dependency trees, artifact hashes, and source-level samples remain
local because they contain private paths and filenames. The harness entry point is
`pnpm benchmark:real-world --project <name=path> ... --repeats 3 --output <temporary-directory>`.

## Resource results

Times below are internal scan medians from three processes. RSS ranges are fresh-process ranges;
the release peak is the maximum across all fresh and warm processes.

| Target          | Fresh median | Warm median |     Fresh RSS range | Release peak |      Gate | Result |
| --------------- | -----------: | ----------: | ------------------: | -----------: | --------: | ------ |
| `shade-factory` |      9.347 s |     0.989 s | 1224.27–1227.00 MiB |  1227.00 MiB | 1,246 MiB | PASS   |
| `crm-back`      |      6.770 s |     0.417 s | 1197.25–1204.52 MiB |  1204.52 MiB | 1,443 MiB | PASS   |
| `crm-front`     |      7.488 s |     0.746 s |   868.36–871.86 MiB |   871.86 MiB |   972 MiB | PASS   |

The earlier August clean-commit report recorded peaks of 1,834.97, 2,347.98, and 1,149.69 MiB
respectively. Those values are historical context, not a controlled speed or RSS comparison:
the OS and dependency trees changed. Release approval here uses the original absolute thresholds,
not relaxed thresholds or historical percentage estimates.

## Correctness and retained evidence

All nine fresh scans produced byte-identical artifacts across CWDs. All nine warm scans reported
`wrote: false`, empty changes, identical counts, and unchanged artifact hashes. Each final `check`
reported current, and each packaged API load returned the persisted counts.

The original `4204e97` scanner was also run on these exact restored projects and dependency trees.
For every target, all six companion artifacts are byte-identical to that reference: overview,
project, files, symbols, relations, and diagnostics. Manifest source records, semantic inputs, and
companion hashes also match. Resolver/producer metadata and the configuration hash change as
expected for the new resolver version. No freshness inputs were removed to save memory.

| Target          | Files | Symbols | Relations | Diagnostics | Semantic inputs | False local-as-external |
| --------------- | ----: | ------: | --------: | ----------: | --------------: | ----------------------: |
| `shade-factory` |   524 |   1,474 |    74,465 |          25 |          21,256 |                       0 |
| `crm-back`      |   209 |   1,912 |    32,389 |           1 |           7,107 |                       0 |
| `crm-front`     |   786 |   3,055 |    56,052 |         350 |          11,025 |                       0 |

## Cause and fix

Programs and TypeCheckers from completed units stayed resident until V8 chose to collect them.
Profiles separated construction, analysis, normalization, and serialization; one completed large
unit still had roughly 880 MiB of unreachable compiler allocations before handoff.

Default scans now analyze units in sequential workers. A local V8 collection before result
handoff reclaims compiler garbage; waiting for worker exit releases its heap before the next unit
or main-thread normalization. The inspector session opens no network port and saves no profile.
Default workers skip TypeScript JSDoc prose while retaining JavaScript JSDoc type information.
Custom analyzers, parsers, and resolvers retain their existing in-process behavior and full JSDoc.

An intermediate clean candidate passed correctness but peaked at 1,254.13 MiB on `shade-factory`.
It was rejected. JSON-buffer handoff increased memory and was discarded. The released change keeps
the structured result protocol and collects unreachable compiler objects before cloning.

## Verification and limits

- `AI_CODE_MAP_TEST_OPTIONAL_FRAMEWORKS=1 pnpm test`: **55 tests passed**, including Next.js and NestJS.
- Lint, typecheck, formatting, generated schema synchronization, and build passed.
- The CLI version regression test failed with the former hard-coded version and passed after
  wiring `--version` to `package.json`.
- Clean consumer installation and CLI `init`, `scan`, `check`, `show`, plus API load, symbol query,
  unchanged rescan, and freshness checks passed on TypeScript/Node, React, and compiler-unit fixtures.
  `tsx` was absent; the worker ran using only production dependencies.
- The exact benchmarked tarball is the local release artifact. Its checksum is verified again
  after integration.

Validation ran on macOS arm64 / Node 22. Linux, Windows, and other Node majors were not executed
in this session. Large individual compiler units can still require substantial memory; the three
repository gates are measured acceptance criteria, not a universal heap bound. Custom pipelines
are not covered by the default worker memory policy. Later query/MCP/watch features remain deferred.
