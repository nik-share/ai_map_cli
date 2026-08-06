# Security policy

AI Code Map is designed for local, static analysis and currently has no background telemetry or remote upload in alpha scanning flow.

## Reporting issues

- Review public issues and avoid sharing repository secrets, `.env` values, or private source content.
- Report vulnerabilities by opening an advisory in the project security channel.
- For GitHub-based reporting:
  `https://github.com/example/ai-code-map/security/advisories/new`

## Security boundaries to preserve

- Do not execute scanned project code.
- Do not follow symlinks outside the resolved project root.
- Avoid resolving or serializing arbitrary runtime values.
- Keep path handling root-relative and normalized.
- Keep source code snippets minimized and only emit explicit, documented evidence fields.
