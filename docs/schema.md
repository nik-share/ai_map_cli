# Data schema quick reference

This document summarizes public record shapes in plain terms.

## Config schema (`config.schema.json`)

`init` writes a complete configuration with these fields. The runtime schema also supplies defaults when fields are omitted:

- `version: 1`
- `root: string`
- `include: string[]`
- `exclude: string[]`
- `frameworks: Array<"auto"|"typescript"|"node"|"react"|"nextjs"|"nestjs">`
- `output: string`
- `includePrivateSymbols: boolean`

Optional:

- `tsconfig: string`
- `concurrency: number` (1..64)

Defaults are provided by `initProject`/`createDefaultConfig`.

## FileRecord shape

```text
id, path, language, frameworks, hash, lines
imports: [{ source, specifiers, resolved, external, kind, line }]
exports: [{ name, local, source, default, typeOnly }]
symbolIds: string[]
env: string[]
operations: [{ kind, api, line }]
syntax: { parser, factCount, hadErrors, fallbackFrom? }
```

## SymbolRecord shape

```text
id, name, kind, file, range, exported, defaultExport?
signature?, documentation?, facts, sourceHash
```

## RelationRecord shape

```text
from, type, to, confidence
origin{ file, line, range, explanation, classification, analyzer }
```

`confidence` is expected to stay in `[0, 1]`.

`origin` also contains a full `range`, required `explanation`, producing `analyzer`, and `classification` (`exact`, `framework-derived`, `heuristic`, or `derived`).

Zod schemas in `src/schemas.ts` are the runtime/type source of truth. Checked-in Draft 2020-12 schemas under `schemas/` and `config.schema.json` are generated with `pnpm schema:generate` and verified with `pnpm schema:check`.

## DiagnosticRecord shape

```text
code, severity, message, file?, line?, column?
```

## CLI output reference

- `init` JSON: `{ root, configPath, created }`
- `scan` JSON: `{ root, outputDir, wrote, changes, elapsedMs, counts, criticalParseErrors }`
- `check` JSON: `{ status, current, root, outputDir, reasons, changes }`
- `show` JSON: `{ selector, matches }`

`show.matches[n] = { symbol, file, inbound, outbound }`.
