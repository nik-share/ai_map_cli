# Changelog

## Unreleased

- Preserve end-of-file line numbering in `read` and `context` so Next.js route handlers ending in LF or CRLF remain readable.
- Recognize root and `src` `proxy.ts`/`proxy.js` files as Next.js special files. Update the Next.js analyzer version so existing maps require a rescan.

## 2026-11-01

### 0.1.0-alpha.4

- Automatically select the experimental Next.js analyzer when `frameworks: ["auto"]` detects a `next` dependency. Explicit framework lists can enable or disable it.
- Support `src/app` and `src/pages`, including page-to-layout links.
- Recognize exported HTTP handlers from destructuring, aliases, re-exports, and wrappers. Exclude local functions and type-only exports from HTTP methods.
- Index destructured variable bindings and resolve calls to exported handlers.
- Recognize wrapped default exports and root or `src` middleware files.
- Update analyzer versions so existing maps require a rescan. Token savings were not remeasured for this release.

## 2026-11-01

### 0.1.0-alpha.3

- Add bounded `context` / `buildSourceContext` packets with current source, direct symbol links, file-level references, and up to four small outgoing dependencies.
- Add a reproducible token benchmark with fixed budgets, raw usage accounting, and manual paired quality review; accept recursive map exclusions in search commands.
- Token savings remain experimental: the latest 12-attempt, three-project comparison saved 0.9% overall and failed two paired quality comparisons. This release does not claim savings above 10% or quality non-degradation.

- Add `map` to check freshness and return the complete structural graph in one call, with short references and grouped relation counts.

- Include bounded direct symbol links and test call sites on the first `read` page, with reusable IDs and omission counts.

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
