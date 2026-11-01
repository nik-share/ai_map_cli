# Changelog

## Unreleased

- Add map-guided `read` / `readSymbolSource` with bounded source pages, freshness checks, and continuation; update and package agent navigation instructions and a reusable Codex skill.

- Improve multiword symbol search with common plural normalization, name-aware ranking, and explicitly labeled partial matches.

- Add compact text `show` with full source ranges, grouped relations, and explicit omission counts.
- Preserve verbose output through `show --full` and complete records through `show --json`.
- Add `find` / `findSymbols` for bounded symbol discovery and typo suggestions on failed `show` selectors.

## 2026-11-01

### 0.1.0-alpha.2

- Release compiler memory after each unit in default scans by using sequential workers.
- Avoid unused TypeScript JSDoc parsing while preserving JavaScript JSDoc type information.
- Preserve in-process behavior and full JSDoc for custom analyzers and semantic resolvers.
- Retain semantic closure, artifact validation, CWD independence, and unchanged-map reuse.
- Advance the semantic resolver version; maps from the previous version require a rescan.

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
