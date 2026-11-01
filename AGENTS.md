# Agent instructions

## Code navigation

- Use `ai-code-map` to locate relevant symbols when their source location is unknown.
- Run commands from the project root.
- Before using the map, run `pnpm exec ai-code-map check`.
- If the map is missing or stale (exit code 2), run
  `pnpm exec ai-code-map scan`.
- Read the beginning of `.ai/code-map/overview.md` only when broader project
  structure is needed. Skip it for a focused task with a known area of the code.
- Find symbols with `pnpm exec ai-code-map find 'search words'`.
- After `find` identifies a relevant symbol, read its source directly using the
  returned path and range. Read only the sections needed for the task.
- Use `pnpm exec ai-code-map show '<stable-id>'` only to answer an unresolved
  question about symbol relations. Use an ID returned by `find`; do not call
  `show` merely to redisplay a symbol whose source location is already known.
- Do not load entire `manifest.json`, `symbols.jsonl`, or `relations.jsonl`
  files into context. Select only the records relevant to the task.
- Source code is the source of truth. Check it before making changes.
- If the map does not help or a command fails, use regular search with `rg`.
- The map is optional for a simple edit in a known file.
