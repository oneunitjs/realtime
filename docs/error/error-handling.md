# Error Handling — Architecture

**Version:** 1.0  
**Status:** Spec / Implementation Guide  
**Focus:** Web-based real-time systems (Hub, Collaboration Engine, transports, clients)  
**Last updated:** 2026-11-06  
**Related:**  
- [Core Hub Architecture](./CORE_HUB_ARCHITECTURE.md)  
- [Collaboration Engine Architecture](./COLLABORATION_ENGINE_ARCHITECTURE.md)  
- [E2EE Architecture](./E2EE_ARCHITECTURE.md)

---

## Table of Contents

1. [Purpose](#1-purpose)
2. [Error Contract](#2-error-contract)
3. [Error Categories and Policy](#3-error-categories-and-policy)
4. [Retry Mechanism](#4-retry-mechanism)
5. [Error Boundaries and Cancellation](#5-error-boundaries-and-cancellation)
6. [Error Registry](#6-error-registry)
7. [Client Response and Logging](#7-client-response-and-logging)
8. [Integration Across the Stack](#8-integration-across-the-stack)
9. [Testing Requirements](#9-testing-requirements)
10. [Implementation Guidance](#10-implementation-guidance)
11. [Summary](#11-summary)

---

## 1. Purpose

A single, consistent error model makes failures **predictable** across:

- Core Hub (connections, rooms, presence, routing)
- Transports (WebSocket, HTTP)
- Middleware
- Collaboration Engine (CRDT ops, sync, snapshots)
- E2EE layer (crypto failures, key issues)
- Client SDKs running in the browser

**Goals**

| Audience | What they get |
|----------|----------------|
| **Clients (browsers)** | Machine-readable codes, safe human messages, clear retry hints |
| **Operators** | Detailed, correlated diagnostics in logs and metrics |
| **Developers** | Typed errors, one registry, no ad-hoc string matching |

**Hard rules**

- Never expose stack traces, tokens, cryptographic material, private keys, or document content to clients.
- Internal `details` are for logging and debugging only; they are sanitized before any serialization that might leave the server.
- One public `ErrorCode` taxonomy is the source of truth. Internal subclasses exist for ergonomics but must map through the registry.

---

## 2. Error Contract

### 2.1 Public shape

```ts
type ErrorCode =
  // Auth & access
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  // Input & protocol
  | 'VALIDATION_FAILED'
  | 'MESSAGE_TOO_LARGE'
  | 'VERSION_UNSUPPORTED'
  // Capacity & limits
  | 'RATE_LIMITED'
  | 'CONNECTION_LIMIT'
  | 'ROOM_FULL'
  | 'OVERLOADED'
  // Resource existence
  | 'ROOM_NOT_FOUND'
  | 'NAMESPACE_NOT_FOUND'
  | 'DOCUMENT_NOT_FOUND'
  // Connection lifecycle
  | 'CONNECTION_CLOSED'
  // Delivery & async work
  | 'EVENT_TIMEOUT'
  | 'DELIVERY_FAILED'
  | 'RETRY_EXHAUSTED'
  // Collaboration / CRDT
  | 'DOCUMENT_FORBIDDEN'
  | 'CRDT_INVALID_OPERATION'
  // Catch-all
  | 'INTERNAL';

interface PublicError {
  code: ErrorCode;
  message: string;           // safe, generic, user-facing
  retryable: boolean;
  requestId?: string;        // correlation ID for support
  retryAfterMs?: number;     // only when retryable and a delay is known
}
```

### 2.2 Internal representation

```ts
class HubError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
    readonly details?: unknown   // never sent to clients raw
  ) {
    super(message);
    this.name = 'HubError';
  }
}
```

Internal subclasses (`RateLimitError`, `RoomFullError`, `CrdtInvalidOperationError`, …) may exist for typed `catch` blocks and better stack traces. Every subclass **must** be registered and map to exactly one public `ErrorCode`.

`details` may hold structured diagnostic data (resource IDs, validation paths, dependency names). Before any client-facing serialization, `details` are stripped or heavily redacted.

---

## 3. Error Categories and Policy

| Category | Examples | Client retry policy | Public message style |
|----------|----------|---------------------|----------------------|
| **Authentication / authorization** | `UNAUTHENTICATED`, `FORBIDDEN`, `DOCUMENT_FORBIDDEN` | Do **not** retry automatically | Generic (“Not authorized”); no hint about whether the resource exists if that would leak info |
| **Validation / protocol** | `VALIDATION_FAILED`, `MESSAGE_TOO_LARGE`, `CRDT_INVALID_OPERATION`, `VERSION_UNSUPPORTED` | Non-retryable until the client fixes input or upgrades | Specific enough to fix the request, never a stack trace |
| **Rate limit / overload** | `RATE_LIMITED`, `CONNECTION_LIMIT`, `ROOM_FULL`, `OVERLOADED` | Retryable **only after** `retryAfterMs`; use jittered backoff | Include or imply a wait; never encourage tight loops |
| **Transient transport / broker / store** | `EVENT_TIMEOUT`, `DELIVERY_FAILED` (when dependency is temporarily down) | Retry only if the operation is **idempotent** and retry budget remains | “Temporary failure, retry later” |
| **Conflict / version** | `VERSION_UNSUPPORTED`, certain CRDT conflicts | Client must resync or upgrade; **blind retry is unsafe** | Instruct resync / upgrade |
| **Internal** | `INTERNAL`, unexpected exceptions | Not retryable from the client’s perspective | Opaque message + `requestId` only |

**Principle:** The `retryable` flag and optional `retryAfterMs` are part of the contract. Clients should not invent their own retry rules that contradict the server.

---

## 4. Retry Mechanism

### 4.1 When to retry

Retry **only** when:

1. The error is marked `retryable: true`, **and**
2. The operation is idempotent (or carries a stable idempotency key / operation ID), **and**
3. The retry budget (attempt count and overall deadline) has not been exhausted.

**Never** blindly retry a non-idempotent publish or a non-idempotent side effect.

### 4.2 Backoff policy

Use **bounded exponential backoff with jitter**:

- Base delay (e.g. 100–200 ms)
- Multiplier (e.g. 2×)
- Cap (e.g. 10–30 s)
- Full jitter (or equal jitter) to avoid thundering herds
- Maximum attempts **and** an overall deadline

Respect `retryAfterMs` from the server when present (e.g. rate limits); treat it as a lower bound before the next attempt.

### 4.3 Circuit breakers

For dependencies (database, broker, Collaboration Engine store):

- Open the circuit after a threshold of failures.
- Stop sending traffic while open; return a fast `OVERLOADED` or `DELIVERY_FAILED` with `retryable: true` and a `retryAfterMs`.
- Probe half-open after a cool-down.
- Expose circuit state in health checks and metrics.

---

## 5. Error Boundaries and Cancellation

### 5.1 At every async boundary

1. Catch errors.
2. Attach correlation context (`requestId`, `connectionId`, `tenantId`, operation name).
3. Map to a typed `HubError` (or registered subclass) via the registry.
4. Ensure **cleanup always runs** (memberships, timers, pending delivery records, AbortControllers).

Unhandled promise rejections from event handlers must be observed and logged; they must not silently disappear.

### 5.2 Timeouts must cancel work

A timeout should **abort** the underlying work when the platform allows it. Merely racing a promise against a timer does **not** cancel the work and can leave orphaned operations.

Conceptual pattern:

```ts
async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await work(controller.signal);
  } catch (e) {
    throw mapError(e);           // registry mapping
  } finally {
    clearTimeout(timer);
  }
}
```

Use the platform’s timer abstraction at runtime and in tests so fake clocks work. Propagate the `AbortSignal` into downstream calls (DB, broker, crypto, Collaboration Engine).

### 5.3 Disconnect and abort

When a connection moves to `closing` / `closed` (see Core Hub), the connection’s `AbortController` is aborted. In-flight joins, publishes, and syncs must observe the signal and exit quickly, mapping cancellation to an appropriate error (often `CONNECTION_CLOSED`) without treating it as an unexpected internal failure.

---

## 6. Error Registry

The registry is the **single source of truth** that maps:

- Internal exception classes / thrown values  
→  
- Public `ErrorCode`, default message, `retryable` flag, and optional default `retryAfterMs`

### 6.1 Required coverage

Every error that runtime code can throw or that middleware can surface must be registered, including (non-exhaustive):

| Internal concept | Typical public code |
|------------------|---------------------|
| Missing / invalid credentials | `UNAUTHENTICATED` |
| Failed ACL check | `FORBIDDEN` / `DOCUMENT_FORBIDDEN` |
| Schema / field validation | `VALIDATION_FAILED` |
| Oversized frame or payload | `MESSAGE_TOO_LARGE` |
| Rate limiter trip | `RATE_LIMITED` |
| Max connections per user / tenant | `CONNECTION_LIMIT` |
| Room capacity | `ROOM_FULL` |
| Unknown room / namespace / document | `ROOM_NOT_FOUND` / `NAMESPACE_NOT_FOUND` / `DOCUMENT_NOT_FOUND` |
| Connection already closed | `CONNECTION_CLOSED` |
| Event handler timeout | `EVENT_TIMEOUT` |
| Downstream delivery failure | `DELIVERY_FAILED` |
| Retry budget exhausted | `RETRY_EXHAUSTED` |
| CRDT op rejected (schema, causality, actor) | `CRDT_INVALID_OPERATION` |
| Client schema too old / too new | `VERSION_UNSUPPORTED` |
| Dependency unhealthy / circuit open | `OVERLOADED` |
| Anything unexpected | `INTERNAL` |

Remove unused names or document their mapping. Middleware, event delivery, room management, Collaboration Engine, and the client SDK must import the **same** definitions.

### 6.2 Preventing drift

- Prefer a compile-time or lint rule that fails if a thrown public code is not in the registry.
- Avoid duplicating stringly-typed codes in different packages.

---

## 7. Client Response and Logging

### 7.1 What the client receives

```json
{
  "code": "RATE_LIMITED",
  "message": "Too many requests. Try again later.",
  "retryable": true,
  "requestId": "req_01J…",
  "retryAfterMs": 2500
}
```

No stack traces, no internal paths, no tokens, no ciphertext, no document content.

### 7.2 What operators see in logs

- Error code
- Request ID / connection ID
- Operation name
- Tenant ID and resource identifiers (room, document)
- Sanitized details (validation path, dependency name, latency)
- Whether the error was returned to the client

**Redaction rules**

- Credentials, Authorization headers, cookies → redacted
- Private keys, shared secrets, recovery material → never logged
- Document plaintext or CRDT op payloads → not logged by default (sample or hash only under strict access control)
- High-volume expected errors (e.g. routine `RATE_LIMITED`) may be sampled
- Security-relevant events (`UNAUTHENTICATED` spikes, `CRDT_INVALID_OPERATION` that look like protocol abuse, crypto failures) are **never** suppressed

---

## 8. Integration Across the Stack

| Layer | How it uses the error model |
|-------|-----------------------------|
| **Transport adapter** | Maps low-level socket errors and protocol violations into registry codes (`MESSAGE_TOO_LARGE`, `CONNECTION_CLOSED`, …) |
| **Core Hub** | Auth, join, leave, publish, heartbeat expiry all throw / return registered errors; disconnect cleanup must not be skipped on error |
| **Collaboration Engine** | Invalid ops, missing documents, version mismatches → `CRDT_INVALID_OPERATION`, `DOCUMENT_NOT_FOUND`, `VERSION_UNSUPPORTED`, etc. |
| **E2EE layer** | Crypto failures fail closed; surface as validation / forbidden / internal as appropriate — never leak why decryption failed beyond a safe code |
| **Client SDK** | Reads `code` + `retryable` + `retryAfterMs`; drives reconnect, resync, or user-visible messages; never retries non-retryable codes in a tight loop |

A single `requestId` (or equivalent correlation ID) should flow from the incoming client message through Hub, Collaboration Engine, and logs so support can trace an incident end-to-end.

---

## 9. Testing Requirements

Minimum coverage:

| Area | What to assert |
|------|----------------|
| Mapping | Every registered internal error produces the correct public `ErrorCode` and `retryable` flag |
| Subclass coverage | All runtime subclasses are registered; no orphan codes |
| Serialization | Client payload never contains stacks, tokens, or raw `details` |
| Cancellation | Aborted work stops; cleanup runs; correct code returned |
| Retry eligibility | Only retryable + idempotent operations are retried; budgets and deadlines are respected |
| Jitter / backoff | Delays stay within configured bounds |
| Deadline expiry | `withDeadline`-style helpers abort and map to the expected error |
| Exhausted retries | Final error is `RETRY_EXHAUSTED` (or the underlying cause if preferred by policy) |
| Circuit breaker | Opens, rejects quickly, half-opens, and recovers as designed |
| Cleanup after exceptions | Memberships, presence, timers, and pending delivery records are not leaked when a handler throws |

Add a **compile-time or lint check** that prevents introducing a public error code that is not in the registry.

---

## 10. Implementation Guidance

1. **One package / module** owns the registry and `HubError` base class; all other packages import from it.
2. Prefer throwing typed errors over returning boolean success flags that hide the reason.
3. At the outermost boundary (WebSocket message handler, HTTP request handler), catch everything, map via the registry, log with correlation IDs, and send only the `PublicError` shape.
4. Propagate `AbortSignal` through Hub → Collaboration Engine → storage so disconnects and deadlines actually cancel work.
5. Treat `INTERNAL` as a bug signal: metric + alert, not a normal control-flow path.
6. Document any intentional deviation (e.g. “this path returns `FORBIDDEN` instead of `DOCUMENT_NOT_FOUND` to avoid existence leaks”) next to the code and in the security model.

---

## 11. Summary

This error-handling architecture provides a **single, machine-readable contract** for the entire real-time stack:

- A fixed set of public `ErrorCode` values with clear retry semantics
- Internal typed errors that always map through one registry
- Strict separation between safe client messages and detailed operator logs
- Bounded, jittered retries only for idempotent, retryable failures
- Timeouts and disconnects that **cancel** work, not just abandon promises
- Mandatory cleanup and no leaked memberships / timers / delivery records
- Test and lint rules that keep the registry and the implementation in sync

Clients can rely on `code`, `retryable`, and `retryAfterMs`. Operators can rely on correlated, redacted logs. Developers can rely on one taxonomy instead of scattered string matching.

---

*This document is the authoritative architecture reference for error handling. All Hub, Collaboration Engine, transport, and client-SDK error paths must conform to the contract, registry, and policies defined here.*