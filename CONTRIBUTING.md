# Contributing Bug Reports

Thank you for helping improve `@oneunit/realtime`! This guide covers how to report bugs effectively through GitHub.

## Before You File

1. **Check existing issues** — search open and closed issues to see if the bug was already reported.
2. **Upgrade** — make sure you're on the latest `1.0.0-beta` release.
3. **Minimize** — create the smallest reproduction using only the public API (`@oneunit/realtime`).

## Filing a Bug on GitHub

1. Click **New issue** → **Bug Report**.
2. Use the provided template — complete every section.
3. Use a clear title with a `[component]` prefix, e.g. `[core-hub] publish to room without membership check succeeds`.
4. Include environment details: OS, Node.js version, package version, transport, codec.
5. Include a minimal TypeScript reproduction using public APIs only.
6. **Redact all secrets** — no tokens, credentials, keys, or customer data.
7. Submit the issue.

## What Happens Next

The `bug-triage.yml` GitHub Action will:

1. Add the `triage` label if missing.
2. Post a comment with guidance and a link to `docs/BUG_REPORTING.md`.
3. Flag the issue for maintainer review.

A maintainer will then:
- Reproduce the issue using your steps
- Assign priority and milestone
- Develop a fix with a regression test
- Run `npm run verify` (build, typecheck, test, pack:check)
- Ship the fix in a subsequent release

## Security Vulnerabilities

Do **not** file security issues publicly. Use the repository's [security advisory](https://github.com/oneunitjs/realtime/security/advisories/new) process for encryption weaknesses, authentication bypasses, or tenant isolation breaches.
