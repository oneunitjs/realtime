# Middleware — Architecture

**Version:** 1.0  
**Status:** Spec / Implementation Guide  
**Focus:** Web-based real-time Hub (connections, rooms, events, collaboration)  
**Last updated:** 2026-11-06  

**Related documents:**  
- [Core Hub Architecture](./CORE_HUB_ARCHITECTURE.md)  
- [Error Handling Architecture](./ERROR_HANDLING_ARCHITECTURE.md)  
- [Event Management and Delivery](./EVENT_MANAGEMENT_ARCHITECTURE.md)  
- [Collaboration Engine Architecture](./COLLABORATION_ENGINE_ARCHITECTURE.md)  
- [Implementation Plan](./IMPLEMENTATION_PLAN.md)

---

## Table of Contents

1. [What Middleware Is](#1-what-middleware-is)
2. [Contract](#2-contract)
3. [Execution Mechanism](#3-execution-mechanism)
4. [Pipelines and Ordering](#4-pipelines-and-ordering)
5. [Rate Limiting](#5-rate-limiting)
6. [Transformations, Timeouts, and Cancellation](#6-transformations-timeouts-and-cancellation)
7. [Error Behavior](#7-error-behavior)
8. [Identity and Immutability Rules](#8-identity-and-immutability-rules)
9. [Testing Requirements](#9-testing-requirements)
10. [Implementation Guidance](#10-implementation-guidance)
11. [Summary](#11-summary)

---

## 1. What Middleware Is

Middleware is an **ordered pipeline** for cross-cutting behavior that must run at well-defined lifecycle boundaries in the Core Hub and related services.

Typical responsibilities:

| Concern | Examples |
|---------|----------|
| Security context | Attach trusted principal, reject unauthenticated work |
| Authorization | `room:join`, `document:write`, event-level ACLs |
| Validation | Schema, size limits, protocol version |
| Rate limiting | Per principal, tenant, IP, or resource |
| Observability | Logging, tracing, metrics |
| Transformation | Normalize payloads (with strict rules) |
| Feature gates | Flags, tenant capability checks |

Middleware must have **deterministic continuation semantics**: every stage either continues the pipeline exactly once, short-circuits with an explicit reason, or fails into the shared error boundary.

It is not a place for core business logic (CRDT merge, room membership mutations). Those live in dedicated modules that middleware may call *after* auth and validation succeed.

---

## 2. Contract

This design uses a **Koa-style single continuation** contract:

```ts
type Middleware = (
  ctx: HubContext,
  next: () => Promise<void>
) => Promise<void>;
```

### Rules

| Rule | Detail |
|------|--------|
| `next()` at most once | Calling it twice is a **programming error** and must throw |
| Not calling `next()` | Short-circuits the pipeline; middleware **must** set an explicit rejection / response reason on the context |
| Errors | Thrown or rejected promises bubble to the central error boundary and are mapped through the [Error Handling](./ERROR_HANDLING_ARCHITECTURE.md) registry |
| Before / after | Middleware may run logic before `await next()` and after it returns (e.g. timing, audit) |

Prefer this single-style contract over mixing “return result objects” and “call next” in the same codebase. If an explicit result contract is introduced later, document it as a separate, versioned change.

---

## 3. Execution Mechanism

Conceptual dispatcher:

```ts
async function dispatch(stack: Middleware[], ctx: HubContext): Promise<void> {
  let index = -1;

  async function run(i: number): Promise<void> {
    if (i <= index) {
      throw new Error('next() called more than once');
    }
    index = i;
    const fn = stack[i];
    if (fn) {
      await fn(ctx, () => run(i + 1));
    }
  }

  await run(0);
}
```

**Production requirements beyond the sample**

- Explicit **terminal handler** (final stage that performs the actual action if nothing short-circuited)
- **Deadline / cancellation** support via `AbortSignal` on the context
- Deterministic order (array order = execution order)
- No dynamic insertion of middleware mid-request unless done through a versioned, atomic pipeline swap

The snippet above illustrates the mechanism only; ship a tested implementation.

---

## 4. Pipelines and Ordering

Do **not** use one global pipeline for everything. Define **separate pipelines** for different lifecycle boundaries:

| Pipeline | When it runs |
|----------|----------------|
| **Connection** | Accept transport → authenticate → mark authenticated |
| **Room join / leave** | Membership changes |
| **Inbound event** | Client → Hub message |
| **Outbound event** | Hub → client (optional transform / filter) |
| **Document operation** | Collaboration Engine op submit / apply path |

### Recommended inbound event order

```text
1. Parse + size check
2. Authenticate connection (or verify already authenticated)
3. Attach trusted principal to context
4. Authorize action
5. Rate limit
6. Validate schema / protocol version
7. Feature / domain handler
8. Audit + metrics
```

Outbound pipelines are typically thinner (metrics, optional redaction, backpressure signals).

**Registration policy:** Freeze the middleware stack after startup, or replace it only through an atomic versioned update. Avoid per-request mutation of the stack.

---

## 5. Rate Limiting

### 5.1 Algorithm clarity

Choose **one** algorithm per policy and implement that algorithm. Do not document “token bucket” while shipping a fixed window.

| Algorithm | Good for |
|-----------|----------|
| **Token bucket** | Smoothing bursts while enforcing a sustained rate |
| **Fixed / sliding window** | Simple quotas (e.g. N requests per minute) |

For token bucket, configure at least:

- `capacity` (burst size)
- `refillRatePerSecond`
- **Key** (principal, tenant, IP, room, document, or a combination)

### 5.2 Distribution

| Deployment | Store |
|------------|--------|
| Single instance | In-memory is acceptable for that instance only |
| Multi-instance | **Atomic shared store** (Redis, etc.) so limits are global |

Local in-memory limits must not be described as cluster-wide.

### 5.3 Client response

On limit exceeded:

- Map to `RATE_LIMITED` via the error registry
- Set `retryable: true`
- Include `retryAfterMs` when known

Clients must back off; do not encourage tight retry loops.

---

## 6. Transformations, Timeouts, and Cancellation

### 6.1 Payload transformation

If middleware mutates payloads:

1. Validate the **transformed** output against the downstream schema.
2. Document which fields are **immutable** (see §8).
3. Prefer additive normalization over silent rewriting of security-sensitive fields.

### 6.2 Timeouts

- Apply deadlines to async middleware.
- Propagate `AbortSignal` from the connection / request context.
- A “timeout race” that does not cancel underlying work can leave background tasks running — treat that as a bug.

### 6.3 CPU-heavy work

Avoid blocking the event loop with heavy crypto, large JSON parse, or compression on the request path. Offload or bound the work; fail with a typed error when limits are exceeded.

---

## 7. Error Behavior

- All middleware exceptions and rejections go through the shared **error registry**.
- Short-circuit without `next()` must still produce a typed public error (or a documented internal-only terminal state).
- After an error, downstream middleware in that pipeline does not run.
- Cleanup registered on the context / connection (timers, temporary reservations) must still run — typically via Hub disconnect paths or `finally` in the dispatcher.

Never leak stack traces, tokens, or cryptographic material in middleware-generated client messages.

---

## 8. Identity and Immutability Rules

**Hard rules — user middleware must not be able to override:**

| Field / result | Why |
|----------------|-----|
| Verified identity (`Principal`) | Stops privilege escalation |
| Tenant ID | Stops cross-tenant access |
| Authorization decision already computed | Stops bypass |
| Server-assigned `messageId` / `opId` | Stops idempotency and audit attacks |

These values are set by trusted stages early in the pipeline and treated as read-only afterward. Attempts to overwrite them are programming errors or security events.

---

## 9. Testing Requirements

| Area | What to cover |
|------|----------------|
| Order | Middleware runs in registration order |
| Short-circuit | Skipping `next()` stops the chain and surfaces a reason |
| One-time `next()` | Double call throws |
| Thrown errors | Mapped via registry; later stages skipped |
| Async rejection | Same as thrown errors |
| Timeout + cancellation | Work actually aborts; no orphaned tasks |
| Payload mutation | Downstream sees validated transformed data |
| Identity immutability | Principal / tenant / authz / IDs cannot be overwritten by later stages |
| Rate limiting | Correct algorithm behavior; distributed store behavior under concurrency |
| Cleanup | Resources released on error and on short-circuit |
| Frozen registration | Stack does not change mid-flight in production mode |

---

## 10. Implementation Guidance

1. **One dispatcher implementation** shared by all pipelines; vary only the stack arrays.
2. Put `HubContext` fields for signal, principal, requestId, and deadline in a single well-typed object.
3. Keep domain handlers thin: middleware prepares a safe context; the handler performs the action.
4. Align rate-limit and validation errors with [Error Handling](./ERROR_HANDLING_ARCHITECTURE.md) codes (`RATE_LIMITED`, `VALIDATION_FAILED`, `FORBIDDEN`, etc.).
5. Log middleware stage timing at debug/trace level; avoid logging full payloads by default.
6. For multi-instance rate limits, document the shared store and failure mode (fail open vs fail closed) explicitly.
7. Freeze stacks after boot in production; if hot-reload of middleware is required, use versioned atomic swap and test it.

---

## 11. Summary

Middleware in this system is an **ordered, single-continuation pipeline** used at connection, room, event, and document-operation boundaries.

- `next()` is called at most once; omitting it short-circuits with an explicit reason.
- Separate pipelines keep connection auth, room join, and event handling understandable and testable.
- Inbound order prioritizes parse → auth → principal → authorize → rate limit → validate → handler → audit.
- Rate limiting uses one documented algorithm per policy and a shared store when running multi-instance.
- Timeouts cancel work via `AbortSignal`; identity and authorization results are immutable.
- All failures map through the central error registry.

This keeps cross-cutting concerns consistent across the Hub without turning middleware into an ungoverned plugin free-for-all.

---

*This document is the authoritative architecture reference for Middleware. Pipeline contracts, ordering, rate-limit behavior, and immutability rules defined here must be followed by Hub and related services.*