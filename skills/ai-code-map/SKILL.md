---
name: ai-code-map
description: Use when tracing TypeScript or JavaScript behavior in a project indexed by ai-code-map, or when the user requests map-guided navigation.
---

# Retrieve source through the map

Run from the source project root with its installed CLI. Do not install or upgrade
it just to navigate. Source establishes behavior; graph relations are navigation
hints, and missing edges do not prove absence.

For an unknown flow, start with `ai-code-map context 'action subject words'`.
Include the action as well as the subject, for example `notification mark read`.
This command checks freshness and returns matching
source plus direct neighbors, merging ranges under one shared budget. A separate
`check` or overview is unnecessary before it. Partial matches name unmatched words;
judge relevance from the returned source.

Use that packet to answer or identify a specific missing fact. Reuse its source.
Read a printed omitted range only if it matters. For one dependency outside the
packet, use `read '<stable-id>'` or its bounded source range. If its ID and source
location are unknown, use `find 'qualified symbol name'` first. Do not use another
`context` call merely to read a helper: it also expands callers and neighbors.
Batch independent
reads; combine needed ranges in the same file. Avoid traversing every neighbor or
splitting one useful file window into many tiny symbol reads.

Use targeted `rg` for file-level facts such as route registration, configuration
and test discovery, or for a failed/irrelevant lookup. Discover paths with
`rg --files -g 'pattern'` before reading them. Use
`show '<id>'` only for an unresolved relation question. Do not dump the complete
map for an ordinary source task. Stop when the requested claims have evidence.
In the answer, connect each requested entry point to its inputs, state changes,
error path and caller effects. Keep navigation-status commentary brief.

If `context` is unavailable, check freshness once, then use `find` and `read` or
bounded source ranges. If stale, scan only when writing generated artifacts is
allowed; otherwise use source search. Cite original file and line numbers.
Do not claim token savings without a measured comparison.
