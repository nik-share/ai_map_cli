#!/usr/bin/env bash
set -euo pipefail

ROOT=${1:-.}

pnpm exec ai-code-map init --root "$ROOT"
pnpm exec ai-code-map scan --root "$ROOT" --json
pnpm exec ai-code-map check --root "$ROOT" --json
pnpm exec ai-code-map show Calculator --root "$ROOT" --json
