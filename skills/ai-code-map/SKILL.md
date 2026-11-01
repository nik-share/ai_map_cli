---
name: ai-code-map
description: Navigate indexed TypeScript and JavaScript code with ai-code-map, then read bounded source ranges to answer code questions or prepare changes. Use when the project has ai-code-map or the user asks for map-guided navigation.
---

# Navigate through the code map

Use the map to narrow the source you need, not as an extra survey before reading
whole files. Source is authoritative; map signatures and relations alone do not
establish runtime behavior.

Run from the project root using the installed `ai-code-map` CLI. Use the project's
existing runner, such as `pnpm exec ai-code-map` or `npm exec -- ai-code-map`.
Do not install or upgrade the tool just to apply this skill. If unavailable, use
ordinary targeted search and report that the map could not be used.

## Locate and read

- Check freshness once before navigation with `ai-code-map check`. If it returns
  exit code 2, run `scan` when writing generated map artifacts is allowed. In a
  read-only task, use source search instead of refreshing the map.
- For an unknown location, use `find 'words'` to obtain candidate IDs. Partial
  matches list unmatched words; inspect the relevant candidate, not every result.
- Use `read '<id>'` for the selected symbol. It reads the mapped source window,
  with two context lines per side, at most 80 lines by default. If truncated,
  follow its continuation only when the missing part matters to the question.
- Reuse returned IDs and source. Do not repeat `find` for a known symbol or replace
  its bounded read with a whole-file read. If the next question concerns an
  imported helper, read that helper rather than broadening the current file.
- Use `show '<id>'` for an unresolved relation question. Skip it when the next
  source location is already known. Read the overview only for a task that needs
  broader project structure. Never load entire JSON map artifacts into context.

If the installed CLI lacks `read`, read the returned start/end lines directly,
with at most two context lines per side. Split long ranges into pages of at most
80 lines. If `read` reports stale source, refresh the map when permitted or fall
back to targeted source search; do not trust the stale range.

## Answer the task

For tests or text that the map does not index, search filenames or the relevant
symbol within a known directory first. Read matching test cases instead of dumping
all notification, service, or component tests. Expand only to resolve a specific
missing fact. Stop navigating when the requested claims have source evidence.

Cite the original file and line numbers. A map-guided read is still source
inspection, not a test run. Do not claim token savings without a measured comparison.
