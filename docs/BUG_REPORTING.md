# Reporting Bugs

Use this template when filing a bug report for `@oneunit/realtime`. Complete every section so maintainers can reproduce, triage, and fix the issue quickly.

---

## Bug Report Template

Copy the sections below into a new issue and fill in each field.

### Summary

A one-line description of the bug.

**Title format:** `[component] brief description of the problem`

Examples:
- `[e2ee] replay guard commits message ID before signature verification`
- `[core-hub] room count hardcoded to zero in metricsSnapshot`
- `[transport] backpressure result conflates accepted and dropped writes`

### Description

Describe the problem in detail. What were you trying to do, and what went wrong?

---

### Steps to Reproduce

Numbered steps that another developer can follow to reproduce the issue.

1. Create a hub with ...
2. Connect client A ...
3. Join room ...
4. Publish message ...
5. Observe ...

---

### Expected Result

What should happen according to the documentation or API contract?

---

### Actual Result

What actually happens? Include error messages, stack traces, and any observed side effects.

---

### Minimal Reproduction

Provide the smallest possible code sample that reproduces the bug. Prefer a single TypeScript file using only public APIs.

```typescript
import { createRealtime } from "@oneunit/realtime";

const realtime = createRealtime({
  // ...
});

await realtime.listen();
// ... minimal reproduction ...
```

If the issue is E2EE-related, include the envelope shape (redacted) and key-derivation inputs.

---

### Environment

| Field | Value |
|---|---|
| OS | (e.g., Linux, macOS, Windows) |
| OS version | (e.g., Ubuntu 24.04, macOS 15.4) |
| Node.js version | `node -v` |
| Package version | `npm list @oneunit/realtime` (e.g., `1.0.0-beta`) |
| Transport | (e.g., uWebSockets.js, FakeTransport) |
| Codec | (e.g., JSON, MessagePack) |
| E2EE enabled? | yes/no |

---

### Error Output

Paste logs, stack traces, or console output here. Redact tokens, credentials, keys, and payloads before sharing.

```
<logs or stack trace>
```

---

### Attachments

Attach screenshots, HAR files, tcpdump captures, or logs that help reproduce the issue. Do not attach files containing secrets, credentials, or customer data.

---

### Additional Context

Anything else that may be relevant: frequency of occurrence, related issues, workarounds tried, or whether the bug reproduces in a minimal example versus your full application.

---

## Step-by-Step Guide

### 1. Confirm it is a bug

Before filing, check:

- Does the behavior match the documented API contract in `README.md` and `ARCHITECTURE.md`?
- Have you upgraded to the latest `1.0.0-beta` release?
- Is the issue reproducible with a clean minimal example, or only in your full application?

If you are unsure whether it is a bug or a usage question, describe what you expected and what happened — maintainers can triage it.

### 2. Reproduce consistently

A bug report is most useful when the issue can be reproduced on demand:

- Write the shortest code sample that triggers the problem.
- Use the public API only (`@oneunit/realtime`), not internal modules.
- If the issue is intermittent, note how often it occurs (e.g., "every time", "about 1 in 10 attempts", "only under load").

### 3. Gather environment details

Run these commands and include the output:

```bash
node -v
npm list @oneunit/realtime
```

Record your OS, browser version (if testing from a client), and transport configuration.

### 4. Capture logs and stack traces

- Enable the hub logger when creating the realtime server:
  ```typescript
  const realtime = createRealtime({
    logger: { debug, info, warn, error: console.error },
    // ...
  });
  ```
- Capture `onEvent` callbacks for connection lifecycle events (`connect`, `disconnect`, `join`, `leave`, `send`, `drop`, `broadcast`, `reject`).
- For E2EE issues, include the envelope metadata (protocol version, key epoch, sender device ID) — **never include private keys**.

### 5. Redact sensitive information

Never include the following in a bug report or attachment:

- Access tokens, API keys, signing keys, private keys
- Passwords or credentials
- Customer or user personal data
- Internal hostnames or IP addresses not intended for public disclosure

Replace real values with placeholders like `<REDACTED>` or `example.com`.

### 6. File the issue

Open a new issue and paste the completed template. A good title helps maintainers prioritize:

- **Good:** `[core-hub] publish to room without membership check succeeds`
- **Bad:** `it does not work`

### 7. Respond to follow-up

After filing, you may be asked for:

- A minimal reproduction repository
- Additional log output
- Confirmation that the bug reproduces on a specific version

Please respond promptly so the fix can be verified.

---

## What happens next

1. **Triage** — maintainers label the issue (e.g., `bug`, `security`, `regression`) and assign priority.
2. **Reproduction** — a maintainer attempts to reproduce using your steps. If more information is needed, they will comment on the issue.
3. **Fix** — a patch is developed and accompanied by a regression test.
4. **Verification** — the fix is run through `npm run verify` (build, typecheck, test, pack:check).
5. **Release** — the fix ships in a subsequent `1.0.0-beta.x` or stable release.

---

## Security issues

If you believe the issue is a security vulnerability (e.g., encryption weakness, authentication bypass, tenant isolation breach), do **not** file a public issue. Contact the maintainers through the repository's security advisory process or the project's disclosed security contact.
