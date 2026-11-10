---
name: Bug Report
about: Report a bug or unexpected behavior in @oneunit/realtime
title: '[BUG] '
labels: ['bug', 'triage']
assignees: ''
---

<!--
  Thank you for helping improve @oneunit/realtime!
  Please complete every section. Incomplete reports may be closed without action.
  For security vulnerabilities, do NOT file here — use the security advisory process instead.
-->

## Summary

A one-line description of the bug.

## Component

Which part of the package is affected?

- [ ] Core hub (`src/core/core-hub.ts`)
- [ ] Room adapter (`src/core/rooms/room-adapter.ts`)
- [ ] Document adapter (`src/core/documents/document-adapter.ts`)
- [ ] Transport adapter (`src/transport/uws/uws-transport.ts`)
- [ ] E2EE (`src/e2ee/envelope.ts`)
- [ ] CRDT collaboration (`src/collab/`)
- [ ] Presence (`src/presence/`)
- [ ] Package exports / `package.json`
- [ ] Other (describe below)

## Steps to Reproduce

1. 
2. 
3. 

## Expected Result

What should happen according to the documentation or API contract?

## Actual Result

What actually happens? Include error messages and stack traces.

## Minimal Reproduction

Provide the smallest TypeScript sample using only public APIs:

```typescript
import { createRealtime } from "@oneunit/realtime";

// Your reproduction here
```

## Environment

| Field | Value |
|---|---|
| OS | |
| OS version | |
| Node.js version | `node -v` |
| Package version | `npm list @oneunit/realtime` |
| Transport | e.g. uWebSockets.js, FakeTransport |
| Codec | e.g. JSON, MessagePack |
| E2EE enabled? | yes/no |

## Error Output

```
Paste logs or stack traces here. Redact tokens, credentials, keys, and payloads.
```

## Additional Context

Frequency of occurrence, related issues, workarounds tried, etc.

## Checklist

- [ ] I have read the bug reporting guide at `docs/BUG_REPORTING.md`
- [ ] I am reporting on the latest `1.0.0-beta` release
- [ ] My reproduction uses only the public API
- [ ] I have redacted all secrets and sensitive data
