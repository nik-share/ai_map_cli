# Changelog

## 2026-08-06

### 0.1.0

- Initial alpha implementation and documentation baseline.
- Added CLI commands: `init`, `scan`, `check`, `show`.
- Added deterministic persisted artifacts:
  - `manifest.json`
  - `project.json`
  - `files.jsonl`
  - `symbols.jsonl`
  - `relations.jsonl`
  - `diagnostics.json`
  - `overview.md`
- Added core semantic analyzers:
  - TypeScript/Node symbols and references
  - React component/hook/component-relationship facts
- Added `ai-code-map check` freshness contract with added/modified/deleted/moved reporting.
- Added programmatic exports for scanning, loading maps, showing symbols, and constructing analyzers.
- Added CI pipeline and initial package-level documentation set.
