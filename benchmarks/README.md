# Parser benchmark microbenchmarks

This directory contains local microbenchmarks for comparing parser behavior.

Run:

```bash
pnpm exec tsx scripts/benchmark-parsers.ts
```

The benchmark is intentionally narrow and deterministic:

- It benchmarks a small set of fixtures (`valid-ts`, `valid-tsx`, `partially-invalid-tsx`, `syntax-error-tsx`).
- It compares TypeScript compiler parsing against `@ast-grep/napi` when that package is available.
- It reports per-case parse status and normalized candidate counts, plus timing and RSS observations for cold and warm phases.
- It is a local microbenchmark for development and decision support, **not** proof of representative repository-wide performance.
