# Core Hub — Architecture

**Version:** 1.0  
**Status:** Spec / Implementation Guide  
**Focus:** Web-based real-time connection runtime (WebSocket-first)  
**Last updated:** 2026-11-06  
**Related:** [Collaboration Engine Architecture](./COLLABORATION_ENGINE_ARCHITECTURE.md)

---

## Table of Contents

1. [Why the Core Hub Exists](#1-why-the-core-hub-exists)
2. [What It Owns (and What It Does Not)](#2-what-it-owns-and-what-it-does-not)
3. [High-Level Architecture](#3-high-level-architecture)
4. [Connection Model and State Machine](#4-connection-model-and-state-machine)
5. [Main Mechanisms](#5-main-mechanisms)
6. [Hub Public API](#6-hub-public-api)
7. [Disconnect and Cleanup](#7-disconnect-and-cleanup)
8. [Relationship to the Collaboration Engine](#8-relationship-to-the-collaboration-engine)
9. [Implementation Sequence](#9-implementation-sequence)
10. [Testing Strategy](#10-testing-strategy)
11. [Observability and Operations](#11-observability-and-operations)
12. [Security and Isolation](#12-security-and-isolation)
13. [Summary](#13-summary)

---

## 1. Why the Core Hub Exists

In a web real-time product (collaborative docs, multiplayer boards, live dashboards, chat + presence), the hardest problems are not the CRDT algorithms themselves — they are:

- Accepting thousands of browser WebSocket connections safely
- Authenticating them quickly and correctly
- Knowing which connections belong to which rooms / documents
- Delivering messages only to the right recipients
- Cleaning up cleanly when a tab closes, a laptop sleeps, or the network drops
- Avoiding races when two tabs join the same room at the same time
- Keeping presence (“User X is online”) accurate without leaking state

The **Core Hub** is the central runtime that owns these concerns. It sits between the raw transport (WebSocket, and later SSE or other adapters) and the product logic (rooms, collaboration documents, presence, delivery).

It is deliberately **transport-independent**: a WebSocket adapter turns socket events into a normalized `TransportConnection`; the Hub only sees that interface and applies product rules.

---

## 2. What It Owns (and What It Does Not)

### 2.1 The Hub owns

| Concern | Description |
|---------|-------------|
| Authenticated connections | Lifecycle from connect → authenticate → authenticated → close |
| Room membership | Who is in which room, with capacity and authorization |
| Document subscriptions | Which connections care about which collaborative documents |
| Presence | Online / offline / last-seen derived from connection state |
| Message routing & delivery | Fan-out of events to the correct connections |
| Heartbeats & expiry | Detecting dead connections and cleaning them up |
| Middleware pipeline | Auth, rate limits, logging, tracing around every action |

### 2.2 The Hub does *not* own

| Concern | Owned by |
|---------|----------|
| CRDT merge rules, operation application | Collaboration Engine |
| Durable operation log & snapshots | Collaboration Engine persistence layer |
| Business rules of a specific room type | Product / domain services |
| Long-term user profile storage | Identity / user service |
| End-to-end encryption key management | Optional crypto layer |

The Hub coordinates; the Collaboration Engine reasons about document state.

---

## 3. High-Level Architecture

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ Browser A   │  │ Browser B   │  │ Browser C   │
│ (WebSocket) │  │ (WebSocket) │  │ (WebSocket) │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │
       └────────────────┼────────────────┘
                        │
           ┌────────────▼────────────┐
           │   Transport Adapter     │  ← WebSocket (primary)
           │   (protocol, origin,    │     future: SSE, HTTP long-poll
           │    frame limits)        │
           └────────────┬────────────┘
                        │ normalized TransportConnection
           ┌────────────▼────────────┐
           │       Core Hub          │
           │                         │
           │  • Connection registry  │
           │  • Auth & Principal     │
           │  • Room membership      │
           │  • Document subs        │
           │  • Presence             │
           │  • Routing / delivery   │
           │  • Heartbeats           │
           │  • Middleware           │
           └────────────┬────────────┘
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
  Collaboration    Presence /     Message
  Engine           Room service   Broker
  (docs, ops)                     (optional)
```

**Key idea:** The Hub never talks to a raw socket. It only talks to a `TransportConnection` that can send, receive, and be closed. This keeps the core logic testable without real WebSockets.

---

## 4. Connection Model and State Machine

### 4.1 Canonical lifecycle

Every connection follows exactly one path:

```
CONNECTING → AUTHENTICATING → AUTHENTICATED → CLOSING → CLOSED
```

| State | Meaning |
|-------|---------|
| `connecting` | Transport accepted, provisional record created |
| `authenticating` | Credential being verified (strict deadline) |
| `authenticated` | Trusted `Principal` stored; may join rooms / subscribe |
| `closing` | Teardown in progress; no new work accepted |
| `closed` | Fully cleaned up; record can be discarded |

**Important:** Room membership and document subscriptions are **separate resources**. Do **not** overload the connection state machine with `joined`, `active`, or `in-room` states. A connection can be `authenticated` and simultaneously a member of zero or many rooms.

### 4.2 Core types

```ts
type ConnectionState =
  | 'connecting'
  | 'authenticating'
  | 'authenticated'
  | 'closing'
  | 'closed';

interface ClientConnection {
  id: string;                          // unique connection ID
  state: ConnectionState;
  principal?: Principal;               // only set after successful auth
  transport: TransportConnection;
  connectedAt: number;
  lastSeenAt: number;
  abort: AbortController;              // cancels in-flight work on disconnect
}

interface Principal {
  userId: string;
  tenantId: string;
  roles: string[];
  sessionId: string;
}
```

### 4.3 Why a strict state machine matters on the web

Browsers open and close sockets aggressively (tab close, sleep, network change, bfcache). A clear state machine plus an `AbortController` lets every async path (auth, join, publish) be cancelled cleanly instead of racing with teardown.

---

## 5. Main Mechanisms

### 5.1 Connect and authenticate

1. **Transport adapter** validates the protocol, checks the browser `Origin`, applies frame-size limits, and creates a provisional `TransportConnection`.
2. **Hub** creates an `AbortController`, registers a provisional `ClientConnection` in state `connecting` → `authenticating`, and starts authentication with a **strict deadline** (e.g. 5–10 seconds).
3. Authentication verifies:
   - Signature / token integrity
   - Issuer and audience
   - Expiry
   - Tenant
   - Revocation / session policy
4. On success the Hub stores a **trusted `Principal`** derived only from the verified credential.  
   **Never** trust `userId`, `roles`, or `tenantId` supplied inside later message payloads.
5. On failure, timeout, or disconnect during authentication:
   - Abort all related work
   - Remove the provisional connection record **exactly once**
   - Close the transport
6. Only after the connection is `authenticated` may it join rooms or subscribe to documents.

### 5.2 Join a room

1. Validate room name and tenant scope.
2. Authorize `room:join` against the authenticated `Principal`.
3. **Reserve capacity atomically** (or serialize all mutations for that room) *before* any asynchronous side effects.
4. Add membership **idempotently** using the composite key `(connectionId, roomId)`.
5. Only after membership is committed, publish presence / join notifications.
6. If any step fails, release the reservation and roll back partial state.

**Race prevention**

- Use a per-room mutex / actor, or an atomic store operation.
- After every `await` (auth check, storage write), **recheck** that the connection is still `authenticated`.
- A disconnect while a join is in flight must cancel or fully roll back the join. No half-joined memberships.

### 5.3 Leave a room

Symmetric to join: remove membership idempotently, update presence, and release capacity. Safe to call multiple times.

### 5.4 Heartbeats

Browsers and mobile networks drop connections silently. The Hub must detect this.

Recommended defaults (configurable):

| Parameter | Suggested value |
|-----------|-----------------|
| Client ping interval | 20–30 seconds |
| Server pong deadline | 60–90 seconds (includes network + scheduler grace) |

Rules:

- Update `lastSeenAt` **only** on a valid pong or other authenticated activity.
- When the deadline is exceeded, expire the connection **once**.
- Cleanup must be idempotent: remove memberships, presence leases, document subscriptions, and pending delivery records even if some steps have already run.

### 5.5 Publish / route an event

1. Validate the connection is still `authenticated`.
2. Authorize the specific action (e.g. `document:write`, `room:message`).
3. Resolve target set (room members, document subscribers, or explicit recipients).
4. Hand the event to the delivery layer (in-process fan-out or external broker).
5. Return a typed `PublishResult` (success, partial failure, or error). Never a bare boolean.

---

## 6. Hub Public API

```ts
interface Hub {
  /** Accept a new transport and start authentication. */
  connect(
    transport: TransportConnection,
    credential?: string
  ): Promise<ClientConnection>;

  /** Idempotent teardown. */
  disconnect(
    connectionId: string,
    reason?: string
  ): Promise<void>;

  /** Join a room after authentication. */
  joinRoom(
    connectionId: string,
    roomId: string
  ): Promise<void>;

  /** Leave a room (idempotent). */
  leaveRoom(
    connectionId: string,
    roomId: string
  ): Promise<void>;

  /** Route a client-originated event. */
  publish(
    connectionId: string,
    event: ClientEvent
  ): Promise<PublishResult>;

  /** Inspection helper (mainly for tests / admin). */
  getConnection(
    connectionId: string
  ): ClientConnection | undefined;
}
```

**Design rules**

- Public methods return **typed results or typed errors**, never booleans that hide the failure reason.
- Internal mutation helpers stay private or module-scoped.
- Every method that can be interrupted by disconnect respects the connection’s `AbortController`.

---

## 7. Disconnect and Cleanup

`disconnect` must be **idempotent** and safe to call from many places (client request, heartbeat expiry, transport close, server shutdown).

Recommended sequence:

1. Transition to `closing` **synchronously** (so concurrent callers see the new state).
2. Abort the connection’s `AbortController` (cancels in-flight auth, joins, publishes).
3. Stop accepting new messages from the transport.
4. Remove all room memberships and document subscriptions.
5. Update presence (mark offline / remove lease).
6. Settle or fail any pending delivery records for this connection.
7. Close the transport.
8. Mark the connection `closed` and drop it from the registry.

Cleanup errors are collected and logged but **must not** prevent the remaining steps from running. Use a `finally`-style pattern and a single-flight guard so concurrent `disconnect` calls do not interleave teardown.

---

## 8. Relationship to the Collaboration Engine

| Hub responsibility | Collaboration Engine responsibility |
|--------------------|-------------------------------------|
| Who is connected and authenticated | What the document content is |
| Which connections are in which room | How concurrent edits merge (RGA, LWW) |
| Delivering ops and awareness messages | Applying ops, maintaining version vectors |
| Presence derived from connections | Durable operation log and snapshots |
| Heartbeat and connection expiry | Causal readiness and compaction |

Typical flow for a document edit:

```
Browser → WebSocket → Transport Adapter → Hub
  → authorize document:write
  → Collaboration Engine validates & applies op
  → Hub fans out the accepted op to other subscribers
  → other browsers receive op → local Collaboration Engine applies it
```

Awareness (cursors, typing) usually stays entirely inside the Hub + presence layer and never enters the durable CRDT log.

---

## 9. Implementation Sequence

Build in this order so each layer can be tested before the next is added:

| Step | Focus | Why first |
|------|-------|-----------|
| 1 | Contracts, types, lifecycle state machine, unit tests | Everything else depends on a correct connection model |
| 2 | Authentication path + deadline + abort | Security boundary |
| 3 | Room membership (join / leave) with capacity and races | Core multiplayer primitive |
| 4 | Message routing / publish | Real-time delivery |
| 5 | Heartbeats and expiry | Dead connection cleanup |
| 6 | Full disconnect / cleanup path | No leaks under churn |
| 7 | Optional broker integration | Horizontal scaling |

**Dependency injection** is required for testability:

- `Clock` (so tests control time)
- ID generator
- Auth provider
- Logger
- Membership / presence / subscription stores

---

## 10. Testing Strategy

Minimum scenarios that must pass:

| Scenario | What to assert |
|----------|----------------|
| Invalid credentials | Connection never reaches `authenticated`; record removed |
| Auth timeout | Same as above; no leaked timers |
| Disconnect during auth | Abort + single cleanup; no half-authenticated connection |
| Concurrent joins at capacity | At most N members; losers get a clear error |
| Duplicate join | Idempotent; membership count unchanged |
| Room deleted while join in flight | Join fails cleanly; no dangling membership |
| Repeated disconnect | Idempotent; no double-cleanup errors |
| Heartbeat loss | Connection expires once; memberships and presence cleared |
| Cleanup throws midway | Remaining steps still run; errors logged |
| Tenant isolation | Connection from tenant A cannot join tenant B’s room |
| Reconnect with new connection ID | Old memberships gone; new connection starts clean |

Also assert **no leaked**:

- Membership records
- Presence leases
- Pending delivery tasks
- AbortController listeners
- Timers

Use fake clocks and injectable stores so these tests are fast and deterministic.

---

## 11. Observability and Operations

Recommended metrics:

- Connections by state (`connecting`, `authenticating`, `authenticated`, …)
- Auth success / failure / timeout rates
- Join / leave latency and error rates
- Heartbeat expiry count
- Average and p99 memberships per room
- Cleanup duration and error count
- Publish fan-out size and latency

Logs should include `connectionId`, `userId`, `tenantId`, and `roomId` (where relevant) but never raw credentials or full message payloads by default.

---

## 12. Security and Isolation

| Rule | Reason |
|------|--------|
| Principal only from verified credential | Stops privilege escalation via message fields |
| Origin check in the transport adapter | Mitigates cross-site WebSocket abuse |
| Frame size and rate limits | Protects memory and CPU |
| Tenant scope on every room and document action | Hard multi-tenant isolation |
| Abort on disconnect | Prevents work continuing after the client is gone |
| Idempotent membership and cleanup | Avoids inconsistent state under retries and races |

---

## 13. Summary

The **Core Hub** is the transport-independent runtime that owns:

- Authenticated WebSocket (and future) connections
- A strict connection lifecycle
- Room membership and document subscriptions
- Presence derived from live connections
- Safe join / leave under concurrency
- Heartbeat-based expiry
- Idempotent disconnect and cleanup
- Routing of events to the right recipients

It deliberately does **not** own CRDT merge logic or durable document storage — those belong to the Collaboration Engine. Together they form the backbone of a web real-time collaboration system: the Hub manages *who is connected and where messages go*; the Collaboration Engine manages *what the shared document contains*.

Implement contracts and lifecycle tests first, then authentication, membership, routing, heartbeats, and finally cleanup. Inject time, identity, and storage so the entire surface can be tested without real sockets or a real network.

---

*This document is the authoritative architecture reference for the Core Hub. Implementation code must conform to the state machine, idempotency, and cleanup rules defined here.*