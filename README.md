# AI Code Map

A local CLI that maps TypeScript, JavaScript, and React code so AI coding agents
can find symbols, follow dependencies, and read relevant source. No server,
account, or API key is required. Source code stays on your machine.

## Install

Requires Node.js 22 or newer. In your project:

```bash
pnpm add -D ai-code-map
```

For npm projects, use `npm install --save-dev ai-code-map` and replace
`pnpm exec` below with `npx`.

## Use

Build the map, then ask for source related to a feature or function:

```bash
pnpm exec ai-code-map init
pnpm exec ai-code-map scan
pnpm exec ai-code-map context "feature or function name"
```

The map is stored in `.ai/code-map`. Run `scan` again when `context` reports it
is stale. For focused navigation, use `find "name"`, then `read '<returned ID>'`.

Give your coding agent the [included skill](./skills/ai-code-map/SKILL.md) to use
this workflow. Token savings depend on the task and are not guaranteed.

[Usage and configuration](./docs/guide.md) · [API](./docs/api.md) ·
[Limitations](./docs/limitations.md) · [Changelog](./CHANGELOG.md)
