# Agent instructions

## Code navigation

- Use `ai-code-map` to navigate the project.
- Run commands from the project root.
- Before using the map, run `pnpm exec ai-code-map check`.
- If the map is missing or stale (exit code 2), run
  `pnpm exec ai-code-map scan`.
- When exploring the project for the first time, read the beginning of
  `.ai/code-map/overview.md`.
- Look up specific symbols with
  `pnpm exec ai-code-map show 'src/example.ts#SymbolName'`.
- Read only the relevant source sections using the returned paths and ranges.
- Do not load entire `manifest.json`, `symbols.jsonl`, or `relations.jsonl`
  files into context. Select only the records relevant to the task.
- Source code is the source of truth. Check it before making changes.
- If the map does not help or a command fails, use regular search with `rg`.
- The map is optional for a simple edit in a known file.
