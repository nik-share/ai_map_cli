# AI Code Map

AI Code Map is a local, deterministic code understanding layer for TypeScript, JavaScript, and React projects. It analyzes source files into stable symbols, relations, and diagnostics so AI coding agents can plan with a compact, trustworthy index before opening many files.

## Key properties (alpha scope)

- **Local-only execution**: scanning reads project files and writes local artifacts; no LLM calls are used during analysis.
- **Deterministic by design**: identical inputs produce byte-identical artifacts.
- **Compiler-authoritative**: TypeScript compiler is the trusted semantic layer for symbols, references, imports, and types.
- **Evidence-backed facts**: relations carry a source range, analyzer, classification, and confidence; source code remains authoritative.
- **No network/telemetry by default**: no outbound upload is part of a standard scan.
- **Small CLI**: `init`, `scan`, `check`, `find`, `show`.

## Quick start

```bash
pnpm install
pnpm exec ai-code-map init
pnpm exec ai-code-map scan
pnpm exec ai-code-map check
pnpm exec ai-code-map find "calculator"
pnpm exec ai-code-map show Calculator
```

### Exit codes

| Command | Success                   | Failure behavior                                    |
| ------- | ------------------------- | --------------------------------------------------- |
| `init`  | `0`                       | invalid configuration or environment errors -> `1`  |
| `scan`  | `0`                       | parser errors with `--strict` -> `3`, otherwise `0` |
| `check` | `0` when current          | stale map -> `2`, missing map -> `2`                |
| `show`  | `0`                       | no match -> `1`                                     |
| `find`  | `0`, including no matches | invalid query or limit -> `1`                       |

## CLI command matrix

All commands share these options:

- `--root <path>`: project root to scan (defaults by searching up to nearest `package.json`)
- `--config <path>`: config path (absolute or relative to CWD)
- `--output <path>`: map output directory
- `--json`: machine-readable output where supported

### `ai-code-map init`

Creates `.ai/code-map/config.json` (or `--output/config.json`) only if missing unless `--force` is set.

### `ai-code-map scan`

Analyzes source files and writes map artifacts to output directory.

- `--strict`: exit code `3` if any diagnostic with `code === "parse-error"` has severity `error`.

### `ai-code-map check`

Compares the persisted `manifest.json` against current state and config:

- source hash set changes (`added|modified|deleted|moved`)
- framework/schema/parser/analyzer/config version drift
- schema compatibility

Returns `Current` or `Stale` with machine-readable reasons and change lists.

### `ai-code-map show <selector>`

Displays indexed symbol(s) by:

- exact stable ID
- shorthand `kind:name` (aliases: `component`, `hook`, `function`, `class`, `method`, `interface`, `type`, `variable`, `page`, `controller`, `module`)
- `path` or `path#name`
- exact symbol name

Default text is compact: up to five symbols, full source ranges, signatures capped at 240
characters, and up to 12 relation groups across the response. Repeated relations of the same
direction, type, and endpoint are grouped with occurrence counts. Internal links come first.
Heuristic/unresolved relations, derived inverse links, containment/export edges, and references
that duplicate a more specific relation are filtered. Each symbol reports shown/omitted groups
and filtered record counts. Documentation and facts are available in the full view.

- `--limit <1..50>` changes the total relation-group limit for compact text.
- `--full` preserves the previous verbose text view.
- `--json` preserves the complete `ShowResult`, including all relation evidence.

These are row and signature limits, not a token budget. A failed selector suggests up to five
indexed candidates; it never silently selects a different symbol.

### `ai-code-map find <query>`

Searches indexed symbol names and paths. Quote multiword queries, for example
`ai-code-map find "manager change"`. Exact names/IDs rank first, followed by prefix/substring,
word matches, and bounded typo matching. Word matching normalizes common English plurals
and favors matches in symbol names over paths. Whitespace-separated queries with at least three distinct words
can also return partial matches: at least two words and half the query must match, including
one word in the symbol name. These rank below full matches and typo hints. Partial results
show which normalized terms were unmatched. This is lexical search, not semantic search;
`read` is not treated as a synonym of `viewed`. For example, `notification mark read` can
find `markNotificationsAsViewed` through `notification` and `mark`.

Read the selected symbol with `ai-code-map read '<id>'`. Use `show` when symbol relations are needed.

Results include stable IDs usable by `show`, kinds, and full source ranges. The default is ten
matches; `--limit <1..50>` adjusts this. `--json` returns `{ query, total, truncated, matches }`.
No matches is a successful empty search. Use `rg` for source text or symbols outside the index.

### `ai-code-map read <id>`

Reads current source using an exact stable ID returned by `find`. Includes two lines
of context on each side of the symbol. Output is numbered and limited to 80 source
lines by default; `--limit <1..200>` changes the page size. Long symbols provide an
explicit `--offset` continuation within the same window. Reuse what you have already
read; follow a continuation or another symbol only for an unresolved question.

The first page also lists up to eight direct symbol neighbors and four exact incoming
call sites in test paths (`*.test.*`, `*.spec.*`, or `__tests__/`). Neighbors include
reusable IDs, source ranges, direction, relation type, and evidence classification.
Repeated neighbors are merged. Heuristic and derived inverse relations, containment,
exports, and unresolved or external endpoints are excluded. Test paths are navigation
hints, not proof of test coverage. Missing entries do not prove that no tests exist.
The block stays below 4,000 compact JSON characters and reports eligible entries
omitted by its limits. Continuation pages do not repeat it. Use `show '<id>'` for
more relations when needed.

The file must be inside the project root, regular, and match its indexed hash.
Changed files require `scan` before reading. Source pages over 12,000 characters are
rejected: reduce `--limit`, or use targeted source search for an oversized single line.
`--json` includes source, range, truncation, continuation metadata, and first-page
`navigation`. Source is read
on demand and is not added to persisted map artifacts. Run `check` before navigation;
this command validates the selected source file, not every project dependency.

The packaged `AGENTS.md` describes this navigation workflow. A reusable Codex skill
is included at `skills/ai-code-map/SKILL.md`. Copy the `ai-code-map` folder to your
Codex skills directory and invoke `$ai-code-map`. It guides bounded source reading,
relation lookups, and targeted fallback for unindexed tests; it also supports older
CLI versions without `read` by using the returned source ranges directly.

## Generated artifacts

The scanner writes these deterministic files under the output directory (default `.ai/code-map`):

- `overview.md` (human view)
- `manifest.json`
- `project.json`
- `files.jsonl`
- `symbols.jsonl`
- `relations.jsonl`
- `diagnostics.json`

`project.json` is a required companion artifact. Loading or reusing a map validates it together with
the manifest, JSONL records, diagnostics, and their cross-record ownership/count invariants.

See [`docs/artifacts.md`](./docs/artifacts.md) and [`docs/schema.md`](./docs/schema.md) for exact field-level formats.

## Config

Configuration is read from `config.json` and validated via [`config.schema.json`](./config.schema.json). All paths are root-relative (POSIX) in persisted records.

Default include patterns:

```json
{
  "include": [
    "src/**/*",
    "app/**/*",
    "pages/**/*",
    "lib/**/*",
    "server/**/*",
    "*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}"
  ]
}
```

Default exclusions:

```json
[
  "**/node_modules/**",
  "**/.next/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.git/**",
  "**/.ai/**",
  "**/*.generated.*"
]
```

Full config fields are documented in [`docs/schema.md`](./docs/schema.md).

## Programmatic API example

The programmatic surface is exported from the package root:

```ts
import {
  initProject,
  scanProject,
  loadCodeMap,
  checkFreshness,
  showSymbol,
  createAnalyzer,
  NextJsAnalyzer,
  NestJsAnalyzer,
} from "ai-code-map";

const root = process.cwd();

await initProject({ root });
const scan = await scanProject({ root });
console.log(scan.counts, scan.changes, scan.criticalParseErrors);

const map = await loadCodeMap({ root });
const result = showSymbol(map, "component:UserList");
console.log(result.matches.map((entry) => entry.symbol.id));

const freshness = await checkFreshness({ root });
console.log(freshness.current ? "current" : "stale");

const analyzer = createAnalyzer({
  analyzers: [new NextJsAnalyzer(), new NestJsAnalyzer()],
});
await analyzer.scan({ root });
```

`createAnalyzer` returns a composable scan surface for custom analyzers and parser adapters.

## Stability, evidence, confidence, and freshness

### Stable IDs

- File IDs use `file:<posix-path>`
- Symbol IDs use stable, path-scoped IDs like `component:src/app/App.tsx#AppShell`
- Route and external IDs are explicit prefixes (`route:`, `external:`)

IDs are designed to survive unrelated edits when logical identity is unchanged.

### Evidence and confidence

- Evidence includes parser-origin and file/line ranges in symbol relations.
- Relation origins classify evidence as `exact`, `framework-derived`, `heuristic`, or `derived` and identify the producing analyzer.
- Relation `confidence` is bounded to `[0, 1]`:
  - `1` for compiler-exact resolution
  - lower values when fallback inference is used

### Freshness

Freshness compares:

- manifest/source hashes
- schema version
- analyzer and parser versions
- effective framework selection
- configuration hash including relevant project metadata

`ai-code-map check` reports actionable reasons and exact change buckets.

## Known limitations

- CLI is intentionally alpha: only `init`, `scan`, `check`, and `show`.
- No source execution, no dynamic config loading, no project remote ingestion.
- `show` is a single-symbol query, not a full search/index query language.
- `Next.js` and `NestJS` analyzers are exported and available programmatically but are **experimental and default-off** in CLI because they are not in the default analyzer list.
- Tree-sitter/ast-grep is not enabled in production scans. A pinned ast-grep development spike and microbenchmark exist, while TS/JS/React analysis remains compiler-authoritative.
- Compiler-unit discovery, deterministic file ownership, project references, extended configs, and
  bounded fallback analysis are implemented. Complex conditional package exports and references
  outside the selected root remain bounded limitations.
- No planned Beta/Later capabilities are claimed by default.

## AI-agent instructions (copy/paste)

Use this with your agent context:

### English

Use the Code Map as a navigation index, not as a replacement for source. Start with `ai-code-map init` then `ai-code-map scan`; do not upload map output and do not read every `.ai/code-map` artifact automatically. For each change:

1. Inspect symbols via `ai-code-map show <id|kind:name|name> --json`.
2. Read only the files and symbols directly connected through relations.
3. Keep decisions tied to map evidence and confidence; do not assume behavior beyond relation origin lines.
4. Open and verify the authoritative source before editing.
5. Before finalizing, run `ai-code-map check` to verify no stale output changes.

### Русский

Используйте Code Map как навигационный индекс, а не замену исходному коду. Выполните `ai-code-map init`, затем `ai-code-map scan`; не отправляйте артефакты наружу и не читайте автоматически все файлы `.ai/code-map`. Для каждого изменения:

1. Смотрите символы через `ai-code-map show <id|kind:name|name> --json`.
2. Открывайте только файлы и связи, которые действительно относятся к выбранным символам.
3. Проверяйте решения по доказательствам из артефактов и уровню `confidence`; не делайте предположений без этих данных.
4. Перед изменением откройте и проверьте исходный код как главный источник истины.
5. Перед завершением выполните `ai-code-map check`, чтобы убедиться, что карта актуальна.

Architecture decisions and deferred work are recorded in [`docs/architecture/ADR-0001-hybrid-syntax-and-semantics.md`](./docs/architecture/ADR-0001-hybrid-syntax-and-semantics.md) and [`docs/backlog.md`](./docs/backlog.md).

## Contributing and security

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`SECURITY.md`](./SECURITY.md).

## Changelog

See [`CHANGELOG.md`](./CHANGELOG.md).
