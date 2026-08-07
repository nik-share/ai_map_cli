# Milestone 1.1 semantic hardening — real-world validation

## Status and reproducibility

This report records the final Milestone 1.1 benchmark candidate generated at `2026-08-06T20:17:41.946Z` (2026-08-07 in Asia/Tbilisi). The scanner repository was intentionally dirty because the milestone was not committed. The runner captured the exact base commit plus hashes of the tracked diff, staged state, untracked file contents, and status before and after the run. This report and its JSON were refreshed from that captured result afterward; no executable or test file changed between the run and report refresh.

- Scanner base commit: `4e137c9f305c531df661656d9b04471dba58f013`
- Scanner status hash: `ca40a9587f401264e79fde022e30cc24d1f7bfc38349ed6d08c4c6dd30694aa9`
- Scanner working-state/diff hash: `eff04b17ebd0d1b08d6fccfecdc486feca436d7cf71cee1ba4d8057b0c828ab7`
- Scanner state before/after: identical (45 status entries in the pre-existing dirty worktree)
- Node.js: `v22.16.0`
- pnpm: `11.13.1`
- Platform: macOS 26.5.2 / Darwin 25.5.0, arm64
- RSS measurement: macOS `/usr/bin/time -l` maximum resident set size, in bytes
- Persisted schema: `3`
- Analyzer version: `0.3.0`
- The raw machine-readable result is retained locally and intentionally excluded from the public
  repository because it contains absolute paths and external-project filenames.

The two original CRM path hints did not exist. The benchmark used the clean backend/frontend
repositories discovered locally; their commits matched the intended targets.

| Project         | Target commit                              | Clean before | Clean after |
| --------------- | ------------------------------------------ | -----------: | ----------: |
| `shade-factory` | `ceebf6959753e274ec49828302fcf0c784df13a4` |          yes |         yes |
| `crm-back`      | `9dc687b59c4cf1863658a594adcb94dc1eb9ee11` |          yes |         yes |
| `crm-front`     | `82b2fcd4c44b226998e68590de1d41e718a2692f` |          yes |         yes |

The exact invocation was:

```bash
pnpm benchmark:real-world \
  --project shade-factory=/absolute/path/to/shade-factory \
  --project crm-back=/absolute/path/to/crm-back \
  --project crm-front=/absolute/path/to/crm-front \
  --repeats 3
```

For each target, the runner invoked the source CLI with explicit absolute `--root` and temporary
`--output` arguments, measured one fresh scan, measured three new-process unchanged scans, required
every warm scan to report `wrote: false` with unchanged counts, ran `check --json`, hashed every
artifact, and verified the target Git state was unchanged. The private raw run retains expanded
child commands and working directories.

## Result

All fresh scans, 9 warm scans, and 3 checks succeeded. Every check returned `current: true`; every warm scan returned `wrote: false`; target repositories remained clean.

| Project         | Fresh internal | Fresh wall | Warm median internal | Warm/fresh reduction |     Peak RSS | Files | Symbols | Relations | Diagnostics |  Map size |
| --------------- | -------------: | ---------: | -------------------: | -------------------: | -----------: | ----: | ------: | --------: | ----------: | --------: |
| `shade-factory` |       11.842 s |   12.386 s |              1.110 s |                90.6% | 1,106.34 MiB |   524 |   1,474 |    74,205 |          14 | 37.76 MiB |
| `crm-back`      |        8.562 s |    9.088 s |              0.433 s |                94.9% | 1,797.08 MiB |   209 |   1,912 |    32,389 |           1 | 15.29 MiB |
| `crm-front`     |        7.737 s |    8.208 s |              0.787 s |                89.8% | 1,444.83 MiB |   786 |   3,055 |    55,915 |         350 | 27.85 MiB |

Warm internal measurements were:

- `shade-factory`: 1,215.98 ms, 1,095.96 ms, 1,110.10 ms
- `crm-back`: 433.43 ms, 444.67 ms, 430.30 ms
- `crm-front`: 787.92 ms, 786.74 ms, 784.05 ms

## Milestone 1 comparison

| Project         |           Fresh M1 → M1.1 |            Warm M1 → M1.1 |                 RSS M1 → M1.1 |      Relations M1 → M1.1 |              Map M1 → M1.1 |
| --------------- | ------------------------: | ------------------------: | ----------------------------: | -----------------------: | -------------------------: |
| `shade-factory` | 8.073 → 11.842 s (+46.7%) | 0.520 → 1.110 s (+113.5%) | 1,293 → 1,106.34 MiB (-14.4%) |  72,054 → 74,205 (+3.0%) | 31.14 → 37.76 MiB (+21.3%) |
| `crm-back`      |  7.355 → 8.562 s (+16.4%) |  0.220 → 0.433 s (+97.0%) |  1,689 → 1,797.08 MiB (+6.4%) |  30,746 → 32,389 (+5.3%) | 13.07 → 15.29 MiB (+17.0%) |
| `crm-front`     |  6.102 → 7.737 s (+26.8%) |  0.460 → 0.787 s (+71.0%) |   991 → 1,444.83 MiB (+45.8%) | 49,331 → 55,915 (+13.3%) | 22.66 → 27.85 MiB (+22.9%) |

The comparison uses the target-CWD Milestone 1 fresh measurements and its median unchanged-scan values. Correctness is the priority, but the resource regressions are not hidden: all three fresh times exceed the 15% investigation threshold, and `crm-front` remains materially above the prior RSS gate. `shade-factory` peak RSS improved; `crm-back` RSS rose modestly.

### Investigation

The new manifest records the compiler-observed closure rather than only indexed files:

| Project         | Semantic inputs | In-root hashes | TS-lib hashes | Project probes | TS-lib probes | Symlinks | Manifest size |
| --------------- | --------------: | -------------: | ------------: | -------------: | ------------: | -------: | ------------: |
| `shade-factory` |          22,816 |          5,047 |            86 |         15,533 |             2 |    2,147 |      5.51 MiB |
| `crm-back`      |           7,240 |          1,206 |            64 |          5,489 |             2 |      478 |      1.54 MiB |
| `crm-front`     |          11,025 |          1,977 |            64 |          8,343 |             2 |      638 |      2.54 MiB |

Each target also records one project-scoped child-directory listing; no toolchain directory listing was consumed in this run.

The final closure is larger than the pre-audit candidate because it retains project symlink mappings and project/toolchain-scoped absent, readable, file, and directory probes. A current scan therefore verifies thousands of compiler-consumed bytes and resolution states and opens/hashes every companion before reuse. It remains 89.8–94.9% faster than fresh analysis. The implementation distinguishes content reads from existence-only probes, so files TypeScript merely tested are not blindly content-hashed.

The larger relation sets and serialization artifacts also contribute to fresh cost. Internal calls changed only from 3,234/1,413/2,153 to 3,279/1,418/2,157. Most growth remains external-call evidence, now separated into exact module-attributed and explicit unresolved groups rather than being presented as one quality claim. No relation was removed merely to improve metrics.

The remaining `crm-front` RSS increase and all three fresh-time regressions need repeat-run profiling before the bounded-query milestone. These are single fresh-process measurements on an active workstation, so the report records rather than over-attributes the deltas. Removing semantic closure, configured Program roots, or evidence ranges would weaken the correctness contract and was not used as a performance shortcut.

## Relation grouping summary

The machine-readable result contains the complete grouping by relation kind, resolution state, evidence classification, and internal/external target. The key call groups are:

| Project         | Exact internal calls | Exact module-attributed external calls | Explicit unresolved heuristic calls | Framework renders | Framework hook uses |
| --------------- | -------------------: | -------------------------------------: | ----------------------------------: | ----------------: | ------------------: |
| `shade-factory` |                3,279 |                                  4,092 |                              21,477 |               346 |                  85 |
| `crm-back`      |                1,418 |                                  2,057 |                               8,003 |                 0 |                   0 |
| `crm-front`     |                2,157 |                                  6,358 |                              10,305 |               446 |                 283 |

Examples were checked against their recorded source lines; details are in the [relation-quality audit](milestone-1-1-relation-quality-audit-2026-08-06.md).

## Artifact integrity evidence

Every managed artifact's byte size and SHA-256 are in the JSON result. Representative integrity records are:

| Project | Manifest bytes / SHA-256 | Relations bytes / SHA-256 |
| --- | --- |
| `shade-factory` | 5,782,597 / `8529c4c29c3e8a1cd9821cbe54e19ca9cc8f554d02053b53467d0028314539b4` | 32,289,037 / `03a8bdbb8c036719cb321a8a9f5ab9e334d987bb3ef6212c67470678bd9a6fbc` |
| `crm-back` | 1,616,196 / `5e0e19242b54e61f064bde07175576a7e00f78ec32cdfa3e354398a3b263b109` | 13,068,095 / `f9cb802c4af36ed4363415a4e335d96aa72451dbb2eebbcf136e2aa948500d0d` |
| `crm-front` | 2,668,579 / `42a8f03ab04cbdfca4d81b6be63eb885cf4f4ef50e01551af0e3c0ec416e2d6c` | 23,538,660 / `9b44525db9ed8c1ba7264918ce1074e8b6c728fe93a92ec97ad3bfe3c9225792` |

The persisted manifests also contain hashes for all six companions; `check` verified them before reporting current.

## Interpretation

Milestone 1.1 closes the requested semantic invalidation, complete-map validation, raw-byte identity, producer provenance, project-reference source resolution, fallback ownership, path portability, external attribution, default-import React resolution, and relation-uniqueness cases. The benchmark supports correctness and warm-reuse claims, not a blanket relation-quality or resource-efficiency claim. Fresh-time regressions and the remaining `crm-front` RSS increase remain documented resource-stabilization risks.
