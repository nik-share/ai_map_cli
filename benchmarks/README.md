# Benchmarks

## Agent token benchmark

The goal is fewer total model tokens with answers of equal or better quality.
This harness compares ordinary search with an explicit ai-code-map skill on the
same source snapshots and tasks. It also compares saved runs after a change.
It is a repository development tool, not a command in the published npm package.

### Set up once

Use Node 22+, pnpm, an authenticated Codex CLI that supports `exec --json` and
`--ignore-user-config`, and macOS or Linux. Use disposable source snapshots.
Model runs use the configured Codex account and consume its tokens. A run can
send source excerpts from the configured projects to the selected model.

1. Run `pnpm build` after changing ai-code-map.
2. Copy `benchmarks/token-benchmark.example.json` to `benchmarks/tokens.local.json`.
3. Set project paths, tasks, quality criteria, model, and the Codex command.
4. Set each map variant's `mapCli` to its built JavaScript entry and `skill` to
   its exact `SKILL.md`. Add other instruction files through `instructions`.
5. Generate current maps in each snapshot before the experiment. The harness
   checks maps but does not rebuild them or install dependencies.
6. Check the configuration without starting a model:

   ```bash
   pnpm benchmark:tokens --check
   ```

Paths inside the configuration are relative to that configuration file. Local
configuration and raw results are ignored by Git. Do not publish them without
review: they can contain private source, answers, paths, and instruction text.

### Run and compare

Run the configured experiment with one command:

```bash
pnpm benchmark:tokens
```

The example uses two variants and two repeats. With three projects and one task
per project, this schedules exactly 12 fresh sessions. Defaults are 180 seconds
per session, 40 minutes overall, and at most two concurrent sessions. Failed
attempts stay in the result. The harness never retries or extends the budget.
Timeout and interruption stop local child process groups. Server-side work
already submitted may finish; this is not a strict billing cap.

Use `--config <file>` for a different suite and `--output <directory>` for
persistent results. Output must be outside every measured source project.
Otherwise the harness prints a unique directory in OS temporary storage; copy
it elsewhere before temporary-file cleanup.

Each result contains `protocol.json`, `summary.json`, `summary.md`, and raw
per-session events, stderr, prompt, invocation, result, and answer. The protocol
records source hashes, runtime settings, exact instruction text and hashes,
CLI hash, model, tasks, rubric, limits, and the complete schedule.

Quality review is separate from execution:

1. Read the answers in `review/` against the saved criteria. File names omit the
   variant; answer wording can still reveal it. The rubric is never sent to the
   measured agent.
2. Fill `quality.json`: score each criterion from 0 to 1 and set `accepted`.
   Leave unknown scores as `null`; record the reason for deductions in `notes`.
3. Run `pnpm benchmark:tokens report <result-directory>`.
4. After another experiment, run:
   `pnpm benchmark:tokens compare <before-directory> <after-directory>`.

`compare` is read-only. It rejects incomplete suites, changed tasks/source,
model or limits, runtime differences, and a changed baseline. Candidate CLI and
skill changes are allowed. Quality must not decrease for any paired task and
repeat. Comparison across saved runs checks each variant against its own prior
answers, not only against the search baseline.

### Interpret the result

- Total tokens = `input_tokens + output_tokens` from Codex `turn.completed`.
  Cached input is part of input. Reasoning tokens, when present, are part of
  output. Neither is added twice. Uncached input is shown separately.
- These are cumulative model-session tokens, not unique source tokens, output
  characters, prices, or scan time. Prebuilding maps is outside model usage.
- Positive `savingsPercent` means fewer tokens. `observedSavings` becomes true
  only for complete pairs with accepted, non-degraded quality scores.
- Missing usage is unknown. Failed, timed-out, skipped, or malformed runs cannot
  establish savings. Per-pair deltas remain visible; an aggregate can hide a
  regression on one project.
- Two repeats are a development signal, not evidence of stable savings across
  arbitrary tasks. Model and server-side cache behavior can vary between runs.

The search control uses a source copy without `.ai` or dependencies. Its source
hash must match the original. Candidate prompts require the exact canonical
Node/CLI path, overriding only the skill's package-runner syntax. This prevents
`pnpm exec` from selecting a different installed version. A candidate must issue
at least one recorded `find`, `read`, `show`, or `map` command through that path;
wrong-executable commands fail the run. Command auditing is evidence for manual
review, not a security proof against a deliberately evasive agent.

The harness supplies the exact skill explicitly. It tests skill-guided behavior,
not automatic skill selection. Repository instruction discovery is disabled;
the known installed ai-code-map skill is disabled in both variants. Use
`disabledSkills` for other installed copies. Keep the same machine and skill
installation between comparisons. Read-only sandboxing and prompt rules reduce
interference but do not prove complete behavioral isolation; inspect raw command
traces when judging results. A reported source or instruction mutation stops the
remaining schedule.

## Parser microbenchmarks

This directory also contains local microbenchmarks for comparing parser behavior.

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
