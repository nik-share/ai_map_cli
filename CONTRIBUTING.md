# Contributing

Thank you for improving AI Code Map.

## Development setup

Use `pnpm` for package management:

```bash
pnpm install
```

## Typical workflow

1. Create or update docs/tests/fixtures as needed.
2. Keep outputs deterministic: stable ordering and stable JSON formatting.
3. Run local checks:

```bash
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
```

## Project principles

- Favor static analysis over runtime behavior.
- Preserve existing behavior and avoid broad rewrites.
- Keep source snippets out of persisted artifacts unless explicitly introduced and safe.
- Preserve determinism for existing tests and fixture outputs.

## Documentation scope

This repository documents an alpha workflow first:

- commands: `init`, `scan`, `check`, `show`
- deterministic map artifacts
- TS/JS/React compiler-backed analysis

## Working with existing changes

Do not revert unrelated user edits in this worktree. Keep changes narrowly scoped and preserve file ownership boundaries when multiple contributors are involved.
