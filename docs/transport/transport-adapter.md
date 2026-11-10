# Transport Adapter — Architecture

**Version:** 1.0  
**Status:** Spec / Implementation Guide  
**Focus:** Web-based real-time Hub (WebSocket-first, library-agnostic boundary)  
**Last updated:** 2026-11-07  

**Related documents:**  
- [Core Hub Architecture](./CORE_HUB_ARCHITECTURE.md)  
- [Error Handling Architecture](./ERROR_HANDLING_ARCHITECTURE.md)  
- [Middleware Architecture](./MIDDLEWARE_ARCHITECTURE.md)  
- [Event Management and Delivery](./EVENT_MANAGEMENT_ARCHITECTURE.md)  
- [Implementation Plan](./IMPLEMENTATION_PLAN.md)

---

## Table of Contents

1. [What the Transport Adapter Is](#1-what-the-transport-adapter-is)
2. [Normalized Contract](#2-normalized-contract)
3. [Handshake Mechanism](#3-handshake-mechanism)
4. [Ownership and Cleanup](#4-ownership-and-cleanup)
5. [Limits and Backpressure](#5-limits-and-backpressure)
6. [Implementation Steps](#6-implementation-steps)
7. [Testing Requirements](#7-testing-requirements)
8. [Integration with the Core Hub](#8-integration-with-the-core-hub)
9. [Summary](#9-summary)

---

## 1. What the Transport Adapter Is

The **transport adapter** isolates the Core Hub from WebSocket-library details.

It:

- Accepts raw upgrade / socket events from a concrete package (`ws`, µWebSockets.js, uWebSockets, native runtime APIs, etc.)
- Converts them into a **small normalized interface** (`TransportConnection`)
- Translates Hub `send` / `close` calls back into the underlying library

The Hub **never** imports the WebSocket library directly. All socket I/O goes through the adapter.

### Critical implementation rule

Use the **actual selected package’s official API**. Do **not** assume `ws`-style APIs such as `WebSocketServer` or `handleUpgrade()` exist on µWebSockets.js or another implementation. Pin the package and version and write the adapter against that API.

---

## 2. Normalized Contract

```ts
interface TransportConnection {
  readonly id: string;

  /** Enqueue bytes to the local socket. Does NOT mean peer receipt. */
  send(data: Uint8Array): Promise<void>;

  close(code?: number, reason?: string): void;

  onMessage(handler: (data: Uint8Array) => void): () => void;  // returns unsubscribe
  onClose(handler: (code: number, reason: string) => void): () => void;

  /** Bytes still buffered in the local transport send path. */
  bufferedBytes(): number;

  readonly remoteAddress?: string;
}

interface TransportAdapter {
  start(options: AdapterOptions): Promise<void>;
  stop(): Promise<void>;
}
```

### Semantics notes

| Method | Meaning |
|--------|---------|
| `send` | Accepted into the **local** socket / adapter buffer (or rejected). It is **not** an end-to-end delivery ACK. Peer receipt requires an application-level ACK ([Event Management](./EVENT_MANAGEMENT_ARCHITECTURE.md)). |
| `onMessage` / `onClose` | May be callback-based under the hood; normalize to this subscription style at the boundary. |
| `bufferedBytes` | Used for backpressure decisions in the Hub / event fan-out layer. |

Binary frames are the preferred application payload. If the library delivers text frames, the adapter converts to `Uint8Array` (UTF-8) consistently and documents the behavior.

---

## 3. Handshake Mechanism

1. **Route** upgrade requests only for the adapter’s configured path and protocol.
2. **Validate**:
   - Browser `Origin` (against an allowlist / policy)
   - Requested subprotocol (if used)
   - TLS / proxy assumptions (e.g. `X-Forwarded-*` only when the proxy is trusted)
   - Frame / message size limits
3. **Authenticate** within a **bounded deadline**, or create a **provisional** connection with strict limits until the Hub finishes auth ([Core Hub](./CORE_HUB_ARCHITECTURE.md)).
4. If this handler **does not own** the path/request, **fall through** to the HTTP server’s normal routing chain. Do **not** destroy unrelated upgrade requests.
5. On timeout or failure: remove listeners and **close only the socket owned by this adapter**.
6. On success: register the normalized `TransportConnection` with the Core Hub. From that point the **Hub owns application lifecycle**.

---

## 4. Ownership and Cleanup

Document **one owner** for socket close.

| Operation | Recommended meaning |
|-----------|---------------------|
| Hub `disconnect` | Hub decides the connection is done → calls transport `close` → adapter cleans bookkeeping |
| Adapter `release(connectionId)` | Prefer: **bookkeeping only** if Hub is responsible for close; **or** close exactly once if adapter owns close — pick one and document it |

Avoid ambiguous dual paths where both Hub and adapter may close the same socket without a single-flight guard.

**Listener hygiene**

- Every `onMessage` / `onClose` (and library-native listeners) must be removed on close and on startup failure.
- Reject sockets that cannot provide required message/close events unless an explicit “manual lifecycle” mode is configured for tests.

---

## 5. Limits and Backpressure

### 5.1 One canonical max frame size

Define a **single** maximum frame / message size used by:

- Adapter (reject before parse)
- Hub
- Feature modules (events, collaboration ops)

Oversized frames are rejected **before** JSON/CBOR parsing.

### 5.2 Buffer thresholds

| Threshold | Behavior |
|-----------|----------|
| Soft | Stop enqueueing new application messages; apply backpressure upstream |
| Hard | Close the connection; map to a typed error / close code |

Monitor `bufferedBytes()` (and library equivalents). A resolved `send()` promise means local accept only — **not** that the browser received or processed the data.

### 5.3 Ping / pong

Prefer library-native ping/pong where available; otherwise implement application heartbeats at the Hub layer. Align timeouts with [Presence](./PRESENCE_MANAGEMENT_ARCHITECTURE.md) and Hub heartbeat policy.

---

## 6. Implementation Steps

1. **Select and pin** the concrete WebSocket package and version.  
2. Write a **thin adapter** against that package’s official API only.  
3. Normalize binary/text frames, ping/pong, close codes, and errors into `TransportConnection`.  
4. Add Origin / subprotocol validation and auth deadlines.  
5. Add bounded send behavior and close-on-overflow.  
6. Ensure **every** listener is removed on close and on startup failure.  
7. Wire `start` / `stop` for clean process shutdown with active connections.

Keep the adapter free of room logic, CRDT logic, and business authorization — those belong in Hub / middleware.

---

## 7. Testing Requirements

| Area | Cases |
|------|--------|
| Upgrade path | Valid path succeeds; invalid path rejected |
| Fall-through | Unrelated upgrades are not destroyed; normal HTTP routing continues |
| Origin | Disallowed Origin rejected |
| Auth timeout | Provisional connection cleaned up; socket closed |
| Frames | Malformed frames, max payload exceeded |
| Encoding | Binary/text conversion consistency |
| Backpressure | Slow socket, soft/hard thresholds |
| Lifecycle | Abrupt disconnect, duplicate close, listener cleanup |
| Shutdown | `stop()` with active connections closes cleanly |
| Integration | **Package-version** tests against the real library, not only mocks |

Mocks are useful for Hub unit tests; the adapter itself needs real-library integration tests.

---

## 8. Integration with the Core Hub

```
HTTP upgrade
    → Transport Adapter (path, Origin, limits)
        → TransportConnection created
            → Hub.connect(transport, credential?)
                → AUTHENTICATING → AUTHENTICATED
                → rooms, events, presence, collaboration

Hub.disconnect / heartbeat expiry
    → transport.close()
        → adapter cleanup (listeners, maps)
```

- Adapter owns **socket I/O and library quirks**.  
- Hub owns **application connection state, auth, rooms, and cleanup orchestration**.  
- Errors at the transport edge map into the shared [Error Handling](./ERROR_HANDLING_ARCHITECTURE.md) model (`MESSAGE_TOO_LARGE`, `CONNECTION_CLOSED`, `UNAUTHENTICATED`, etc.).

---

## 9. Summary

The Transport Adapter is a **thin, library-specific boundary** that presents a stable `TransportConnection` to the Core Hub.

- No Hub code depends on `ws` vs µWebSockets vs other APIs.  
- Handshake validates path, Origin, limits, and auth deadlines; unrelated upgrades fall through.  
- `send` means local buffer accept, not peer receipt.  
- One owner closes the socket; listeners always detach.  
- One canonical max frame size and explicit soft/hard backpressure thresholds protect the process.  
- Real package integration tests are required.

This keeps the Hub testable, portable, and safe under the messy realities of browser WebSockets and Node (or edge) WebSocket libraries.

---

*This document is the authoritative architecture reference for the Transport Adapter. Normalized contracts, handshake rules, ownership, and backpressure behavior defined here must be followed by all transport implementations.*