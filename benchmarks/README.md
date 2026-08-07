# Parser benchmark microbenchmarks

This directory contains local microbenchmarks for comparing parser behavior.

Reviewed aggregate repository-wide results are recorded separately:

- [Real-world alpha baseline — 2026-08-06](results/alpha-real-world-baseline-2026-08-06.md)
- [Milestone 1 real-world validation — 2026-08-06](results/milestone-1-real-world-2026-08-06.md)
- [Milestone 1.1 semantic hardening — 2026-08-06](results/milestone-1-1-real-world-2026-08-06.md)

Raw machine-readable runs, dirty-tree provisional reports, and source-level relation samples stay
local by default because they contain absolute paths and external-project filenames. Publish only a
deliberately reviewed aggregate report.

Run:

```bash
pnpm exec tsx scripts/benchmark-parsers.ts
```

The benchmark is intentionally narrow and deterministic:

- It benchmarks a small set of fixtures (`valid-ts`, `valid-tsx`, `partially-invalid-tsx`, `syntax-error-tsx`).
- It compares TypeScript compiler parsing against `@ast-grep/napi` when that package is available.
- It reports per-case parse status and normalized candidate counts, plus timing and RSS observations for cold and warm phases.
- It is a local microbenchmark for development and decision support, **not** proof of representative repository-wide performance.

## Real-world benchmark harness (Milestone 1.1)

Run reproducible full-repo benchmarks for the three known targets below via pnpm:

```bash
pnpm benchmark:real-world \
  --project shade-factory=/absolute/path/to/shade-factory \
  --project crm-back=/absolute/path/to/crm-back \
  --project crm-front=/absolute/path/to/crm-front \
  --repeats 3
```

Defaults are intentionally external to the repo; use `--projects-config` to point to `benchmarks/real-world/projects.json` for prior Milestone-1 metrics and local default-path hints.

The harness now runs:

- A fresh scan for each of three CWD contexts:
  - `target-cwd` (project directory),
  - `scanner-cwd` (packaged scanner checkout),
  - `temp-cwd` (temporary working dir),
- followed by warm unchanged scans of the target context repeated `--repeats` times.
- a packaged scanner source snapshot + tarball hash in the scanner report.

The package is extracted and dependencies are installed with pnpm offline. If the local store lacks
tarballs, the harness records the failed install and copies the already-installed `node_modules`
tree into the isolated package. Executable code still comes from the checksummed tarball, and this
fallback is disclosed instead of being presented as a clean production install.

Dirty-worktree runs are provisional even when the harness captures an exact reconstructable source
snapshot; the official benchmark remains pending until it is repeated from an authorized clean
commit. Resource-gate failures are reported per project and require an explicit go/no-go decision.

### Options

- `--project <name=path>`: exactly one per target. If omitted, entries in `projects.json` with a `defaultPath` are used.
- `--repeats <n>`: number of warm unchanged scan repeats; each must report `wrote: false` with identical counts.
- `--output <dir>`: base directory for raw run output.
- `--projects-config <path>`: alternate project/baseline config path.
- `--dry-run`: validate target resolution and emit planned run directory without scanning.
- `--help`: print CLI options.

### Output format

Each run writes two files under a unique `run-*` directory:

- `summary.json` (machine-readable full result)
- `summary.md` (human-readable report)

The JSON includes:

- scanner git commit + `git diff` hash + status hash before and after
- per-target git commit, status, and status hash before/after
- exact commands/options/CWDs for each command
- Node, pnpm, platform, wall-time, and RSS strategy
- warm scan and fresh scan stats
- checks for `current` and unchanged-map invariants
- artifact byte sizes and SHA-256 hashes
- relation group counts grouped by relation kind, resolution state, evidence classification, and internal/external target
- deterministic relation samples
- compiler-unit ownership
- prior M1 metrics (from `projects.json`) for comparison
- resource gate status and per-target compactness counters:
  - `exact-internal`
  - `exact-external`
  - `false-local-external`
  - `unresolved-heuristic`
  - `inverse-unresolved`

Heuristic and unresolved relations are measured for auditability but should be excluded from the
future default compact AI context unless specifically requested.

Required command failure or any target mutation (commit/status/diff hash change) returns non-zero and writes partial summary.
