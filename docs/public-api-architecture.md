# Public API Architecture — `@oneunit/realtime`

**Version:** 1.0  
**Status:** Superseded by `docs/architecture-consolidation-uws-plan-v2.md` (uWebSockets.js-only).  
**Scope:** Historical record of the pre-consolidation public API. The consolidated package uses uWebSockets.js as its only WebSocket engine; see the consolidation plan for the current target architecture.

> This document predates the uWebSockets.js-only consolidation. It describes a transport-independent hub with optional `ws`/`uWebSockets.js` adapters and a `Connection` (`readyState`/`send`/`close`) contract. That dual-engine design has been removed: uWebSockets.js is the sole engine, the normalized contract is `TransportConnection`, and framework integrations use a dedicated uWS listener rather than sharing the host server's TCP listener. Do not treat this as the current contract.

---

## 1. Executive Summary

`@oneunit/realtime` is a **transport-independent, in-process realtime hub**. It owns connection lifecycle, channel/room membership, message fan-out, presence, backpressure, heartbeats, and optional end-to-end encryption (E2EE). It **never imports a concrete WebSocket library** — adapters translate transport sockets (uWebSockets.js v20, `ws`, or anything else) into a minimal `Connection` contract.

The core design principle is **separation of transport from semantics**:

```
Browser / SDK
   | versioned WebSocket protocol
   v
Transport Adapter  (uWS prioritized, ws, custom)
   |  Connection (readyState, send, close)
   v
Core Hub
   |-- Authentication / Authorization hooks
   |-- Channels / Rooms (membership, capacity)
   |-- Event Router + Fan-out (send / broadcast)
   |-- Presence + Heartbeat + Backpressure
   |-- Typed errors + structured logging
   `-- E2EE (optional, opt-in per envelope)
```

There is **no broker** in this package. Cross-instance propagation is the consumer's responsibility: hand `hub.broadcast` to whatever broker you run. This keeps single-instance correctness simple and testable before distribution complexity is added.

---

## 2. Design Philosophy & Process Decisions

Every part of this codebase reflects a specific engineering decision. Understanding the *why* matters as much as the *what*.

### 2.1 Transport independence first

The hub never imports `uwebsocket`, `ws`, `fastify`, or `express`. It only ever sees a `Connection` — something with `readyState`, `send(data: Uint8Array)`, `close(code?, reason?)`, and optional `terminate()`/`bufferedAmount`/`ping()`. The transport adapter is the only place that knows about concrete sockets. This means:

- You can unit-test the hub without opening a socket.
- You can swap uWebSockets.js v20 for `ws` (or a mock) without touching hub logic.
- HTTP frameworks (Express, Fastify, etc.) can own the listening server and hand upgrades to the adapter via the `server` option.

### 2.2 One canonical runtime, one legacy runtime

The package currently exposes **two overlapping runtimes**, which is the largest source of developer confusion:

| Runtime | Used by | Methods | Framing |
|---|---|---|---|
| `createRealtimeHub()` / `RealtimeHub` | `examples/chat.ts`, `examples/uws-chat.ts`, `chat-express.ts`, `chat-fastify.ts` | `join`, `send`, `broadcast`, `channelCount` | notepack binary |
| `new Hub()` | legacy path only | `connect`, `joinRoom`, `publish`, `subscribeDocument`, `sendEnvelope` | JSON text |

`createRealtimeHub` is the **canonical** runtime going forward. `Hub` is kept for compatibility but is effectively deprecated; new docs and examples use `createRealtimeHub`.

### 2.3 Fail-safe delivery, never crash on client input

A single malformed client frame must **never** crash the server or disconnect unrelated users. This is baked into every layer:

- **Adapter:** `handleMessage` wraps `onMessage` in try/catch; refused sockets get an `absorbAsyncError` listener so an unhandled `error` event doesn't become an uncaught exception.
- **Hub `write()`:** catches `connection.send()` throws, terminates the socket, disconnects the client, and continues serving everyone else. Backpressure (`bufferedAmount > maxBufferedBytes`) drops frames and terminates slow clients after `maxConsecutiveDrops`.
- **Hub `broadcast()`:** iterates members, isolates per-recipient frame building (`buildFrame` catches encode errors), and never lets one slow or broken member affect others.
- **Hub `close()`:** idempotent, wraps individual socket closes in try/catch.

### 2.4 Authentication before channel membership

A refused peer never costs a connection slot, heartbeat, or E2EE key. The adapter authenticates in the upgrade path *before* calling `hub.join()`. If authentication or authorization fails, the socket is closed immediately (WebSocket close code `1008`) and the client never appears in channel membership or presence.

### 2.5 Authorization is hook-driven, not hardcoded

The hub does not decide who may join which channel. The `authorize` hook receives `{ action, channel, client, metadata }` and returns boolean. The example `chat.ts` authorizes `private:alice` so only `name=alice` may join — but that is example policy, not framework policy. The framework is channel-agnostic.

### 2.6 E2EE is opt-in and server-blind

`createRealtimeHub({ e2ee: true })` generates a hub key pair. `hub.sendEnvelope()` / `hub.broadcastEncrypted()` produce `{ type: "e2ee", ciphertext }` frames. The hub **never decrypts** — it validates envelope schema/size, binds sender identity, authorizes publication, and forwards ciphertext only to channel members. Key distribution and rotation are the consumer's responsibility (out-of-band). This matches the principle that the server should not see plaintext when E2EE is claimed.

### 2.7 Heartbeats are a shared scheduler, not per-connection timers

One `setInterval` sweeps every connection, pings those that support `ping()`, and closes stale ones. Cost does not scale with client count. Transports without protocol-level pings can call `hub.touch(clientId)` on any traffic.

---

## 3. Module Boundaries

| Module | Primary Responsibility | Runtime Dependencies |
|---|---|---|
| `src/core/hub.ts` | `RealtimeHub` — connection lifecycle, auth, channel membership, send/broadcast, E2EE, heartbeat, stats | `notepack.io`, `libsodium-wrappers` (E2EE only) |
| `src/core/core-hub.ts` | `Hub` — legacy runtime: `connect` → authenticate → `joinRoom` → `publish` → `sendEnvelope`; typed `PublishResult` | None (transport-independent) |
| `src/transport/adapter.ts` | `createConnectionAdapter`, `attachWebSocketAdapter` — uWS v20 and `ws` engines, upgrade/auth flow, `Connection` wrapping | `uwebsocket` (default), `ws` |
| `src/error/index.ts` | `HubError`, typed error subclasses, `ErrorRegistry`, `mapError`, `toPublicError`, `withDeadline`, `withRetry`, `CircuitBreaker` | None |
| `src/e2ee/` | `EnvelopeService` (seal/open), raw sodium helpers (`encrypt`, `decrypt`, `sign`, `verify`, `computeSharedKey`, …), key identity managers | `libsodium-wrappers` |
| `src/event/` | `EventService`, `EnvelopeBuilder`, `FanoutScheduler`, `AckHandler`, delivery state machine, bounded fan-out | None |
| `src/collab/` | Custom CRDT engine: RGA text, LWW map, vector clocks, op log, sync handler, client SDK (`CollaborationEngine`) | None |
| `src/core/connection/connection.types.ts` | `HubConfig`, `TransportConnection`, `ClientConnection`, `ClientEvent`, `PublishResult`, `Principal`, `ConnectionState` | None |
| `src/types.ts` | Shared types: `Connection`, `Client`, `RealtimeHubOptions`, `AuthenticateHook`, `AuthorizeHook`, `RealtimeEvent`, `RealtimeAction`, `BroadcastOptions`, `AttachWebSocketAdapterOptions`, etc. | None |

---

## 4. Deep Dive: Each Service

### 4.1 Core Hub (`src/core/hub.ts`)

**What it is:** The canonical runtime. A single-process object that tracks clients, channels, and delivery counters.

**Key design elements:**

- **`RealtimeHub` class** — owns `channels` (`Map<string, Set<ClientEntry>>`), `clients` (`Map<string, ClientEntry>`), `clientIds` (`WeakMap<Connection, string>`), `clientKeys` (`WeakMap<Connection, Buffer>` for E2EE).
- **Lifecycle:** `constructor` → `startHeartbeat()` (optional) → `join()` / `authenticate()` → `send()` / `broadcast()` → `leave()` / `disconnect()` → `close()`.
- **Channel model:** Channels are created lazily on first join. A channel is a `Set<ClientEntry>`. When the last member leaves, the channel is removed. A client with zero channels is released (no slot, no heartbeat, no key) but its socket stays open so it can subscribe again.
- **Limits:** `maxConnections`, `maxClientsPerChannel`, `maxChannelsPerClient`, `maxMessageSize`, `maxChannelNameLength` — all validated at join/send time. Channel names are validated for non-empty, length, and no control characters.
- **Authentication:** `authenticate(context)` runs the user hook once before `join()`. Metadata returned becomes `client.metadata`. Throws `AuthenticationError` on rejection.
- **Authorization:** `authorize(context)` runs for `connect`, `join`, `send`, `broadcast`. `authorizeRecipients: true` in broadcast options authorizes every recipient individually. Throws `AuthorizationError` on denial.
- **Delivery:** `send(target, message)` unicasts; `broadcast(channel, message)` fans out. Both encode via `encodePayload()` (notepack for objects, UTF-8 for strings) and validate size. Delivery is `Promise<boolean>` / `Promise<number>` — slow or broken connections are counted and skipped, never thrown.
- **E2EE:** `sendEncrypted()` / `broadcastEncrypted()` produce per-recipient ciphertext using `encryptWithSharedKey` (X25519 + XChaCha20-Poly1305). Members without a registered key are skipped, not failed. If E2EE is not enabled, `broadcastEncrypted` throws `ConnectionError("E2EE is not enabled on this hub")` rather than silently reporting 0 deliveries (which would look like an empty channel).
- **Heartbeat:** `startHeartbeat()` runs one `setInterval` that pings every connection with a `ping()` method. Stale connections (missed deadline) are disconnected with code `1001`. `touch(clientId)` resets the deadline for transports without protocol pings.
- **Stats:** `stats()` returns point-in-time counters (messages sent/dropped, broadcasts, connections accepted/rejected, authorizations denied, heartbeats, terminations).

**Public types:** `RealtimeHub`, `CreateRealtimeHubOptions`, `RealtimeHubOptions`, `RealtimeHubStats`, `RealtimeLimits`, `HeartbeatOptions`, `BackpressureOptions`, `CONNECTION_OPEN`.

---

### 4.2 Core Hub — Legacy Runtime (`src/core/core-hub.ts`)

**What it is:** A second, lower-level runtime with a stricter lifecycle: `connecting → authenticating → authenticated → closing → closed`. It uses a `Principal` (trusted identity created only by `AuthProvider`) and supports document subscriptions distinct from room membership.

**Key design elements:**

- **`Hub` class** — owns `ConnectionRegistry`, `RoomMembershipService`, `DocumentSubscriptionService`, `PresenceService`, `HeartbeatService`, `DisconnectCoordinator`, `MiddlewareRunner`, `DeliveryService`, `Router`.
- **`connect(transport, credential)`** — registers a transport, runs `AuthProvider.authenticate()` with a strict deadline (`authTimeoutMs`), sets principal and state to `authenticated`, adds presence + heartbeat. On failure, runs idempotent cleanup and throws.
- **`joinRoom(connectionId, roomId)`** — middleware-wrapped, idempotent, capacity-aware, tenant-aware.
- **`publish(connectionId, event)`** — routes to room / document / recipient IDs. Returns typed `PublishResult` (`delivered` \| `partial` \| `rejected`). Excludes sender by default for rooms, includes sender by default for documents.
- **`sendEnvelope(connectionId, envelope)`** — opaque E2EE envelope routing. Validates schema/size, binds sender to principal, authorizes, forwards ciphertext only to room members. Plaintext never seen.
- **Middleware:** `MiddlewareRunner` wraps every protected action (`room:join`, `room:leave`, `document:read`, `document:write`, `event:publish`).
- **Cleanup:** `DisconnectCoordinator` runs idempotent steps (close, remove memberships, remove document subscriptions, release presence, settle delivery, close transport, mark closed).

**Public types:** `Hub`, `HubOptions`, `AuthProvider`, `HubMetrics`, `Principal`, `TransportConnection`, `ClientConnection`, `ClientEvent`, `PublishResult`, `HubConfig`, `ConnectionState`.

---

### 4.3 Transport Adapter (`src/transport/adapter.ts`)

**What it is:** The boundary between concrete WebSocket libraries and the hub's `Connection` contract.

**Two engines:**

1. **uWebSockets.js v20 (`attachUwsAdapter`)** — Default and optimized. `App` owns its listening socket, so the adapter takes a `port`, not an `http.Server`. Authentication happens in the `upgrade` handler *before* `res.upgrade()`, so a refused peer never completes the handshake. Messages arrive as neutered `ArrayBuffer` (copied before async handling). `UWSConnection` wraps `ws.send(data, true)` (binary flag).

2. **`ws` package (`attachWsAdapter`)** — Wraps a `node:http` server (or an existing one via the `server` option) with `WebSocketServer` (`noServer: true`). Authentication runs after upgrade completes; refused peers are closed with `1008`. `ws` sockets are EventEmitters, so the engine owns lifecycle listeners directly. `wrapWebSocket()` adapts to the `Connection` contract.

**Shared logic in `createConnectionAdapter()`:**

- **`authenticate(socket, request)`** — runs hub auth hook before joining; returns `null` on refusal.
- **`attach(socket, request, metadata?)`** — computes channel, joins hub, wraps socket as `RealtimeConnection`, wires `message`/`error`/`close` listeners (for EventEmitter transports), calls `onConnection` hook.
- **`handleMessage(connection, data, isBinary)`** — calls `decodeMessage(data, isBinary)` then the user's `onMessage` handler, catching errors.
- **`close()`** — terminates sockets (not graceful close) so `http.server.close()` is not stalled by peers ignoring the closing handshake.

**Key safety:** `absorbAsyncError()` attaches an `error` listener to refused sockets that have no listener, preventing uncached exceptions from taking down the process.

**Public types:** `attachWebSocketAdapter`, `createConnectionAdapter`, `matchesPath`, `AttachWebSocketAdapterOptions`, `AttachedWebSocketAdapter`, `ConnectionAdapter`, `ConnectionAdapterOptions`, `WebSocketServerLike`.

---

### 4.4 Event Management & Delivery (`src/event/`)

**What it is:** A parallel delivery infrastructure with per-recipient delivery tracking, ACK handling, and bounded retry.

**Key exports:**
- `EventService` — validated, authorized event publishing with optional per-recipient delivery tracking.
- `FanoutScheduler` — bounded fan-out; `AckHandler` — `received` / `processed` ACK kinds.
- `EnvelopeBuilder` — builds wire envelopes.
- `MemoryDeliveryRecordStore` — in-memory delivery state.
- Types: `EventEnvelope`, `PublishOptions`, `PublishResult`, `DeliveryMode`, `DeliveryState`, `DeliveryRecord`, `DeliveryAck`, `EVENT_PROTOCOL_VERSION`.

**Relationship to Core Hub:** The hub has its own `Router` and `DeliveryService` (fan-out to room members). `EventService` is a separate, more granular delivery layer. Both exist today; the long-term direction is to align them so there is one fan-out path.

**Public types:** `EventService`, `EventServiceDeps`, `EventConfig`, `EventEnvelope`, `PublishOptions`, `DeliveryMode`, `DeliveryState`, `DeliveryRecord`, `DeliveryAck`, `HubConnectionView`, `HubMembershipAccess`, `HubAuthorize`, `FanoutScheduler`, `AckHandler`.

---

### 4.5 E2EE (`src/e2ee/`, `src/security/e2ee.ts`)

**What it is:** End-to-end encryption using libsodium (X25519 + HKDF-SHA-256 + XChaCha20-Poly1305 + Ed25519).

**Key exports:**
- `EnvelopeService` — `seal`/`open` (fail-closed), `validateEnvelope`, `encodeEnvelope`.
- Raw sodium helpers: `generateKeyPair`, `generateSigningKeyPair`, `encrypt`, `decrypt`, `sign`, `verify`, `computeSharedKey`, `encryptWithSharedKey`, `decryptWithSharedKey`, `toBase64`, `fromBase64`, `keyToHex`, `keyFromHex`.
- `ReplayGuard` — replay protection.
- `MemoryDeviceIdentityManager`, `MemoryKeyDirectory` — in-memory reference implementations.
- Error classes: `E2EEError`, `UnsupportedVersionError`, `InvalidEnvelopeError`, `EnvelopeTooLargeError`, `InvalidSignatureError`, `UnknownEpochError`, `RevokedDeviceError`, `AeadFailureError`, `NonceMisuseError`, `ReplayError`, `KeyNotFoundError`.

**Wire format:** `{ type: "e2ee", ciphertext: string }` where ciphertext is Base64. Clients can distinguish encrypted from plaintext frames.

**Important:** `createRealtimeHub({ e2ee: true })` generates the hub key pair and awaits `e2eeReady()` (libsodium async init). But the hub does **not** automatically encrypt `send()`/`broadcast()` — developers must call `sendEnvelope()`/`broadcastEncrypted()`. Transparent E2EE (automatic sealing) is a planned improvement, not yet implemented.

**Key distribution:** Out-of-band. The server never sees plaintext when E2EE is claimed; key exchange and rotation are the consumer's responsibility.

---

### 4.6 Collaboration Engine (`src/collab/`)

**What it is:** A custom CRDT engine (no Yjs, no Automerge).

**Server side:** `SyncHandler`, `OpLog` (append-only), `OpValidator`, `AllowAllAcl`, `DocumentAcl`, `ActorInfo`, validation.

**Client SDK (`src/collab/client/`):** `CollaborationEngine`, `MemoryStorage`, `FakeTransport` (tests only — no real WebSocket transport yet), `Transport` interface, RGA text sequence with tombstones, LWW map registers, vector clocks.

**Design:** Operation schema with actor counters, vector-clock causal context, deterministic merge and render, append-only log + snapshots, version-vector exchange + snapshot-plus-tail sync. Single document type initially; richer types require proven convergence first.

**Relationship to Core Hub:** Document subscriptions exist in `Hub` (`subscribeDocument`/`unsubscribeDocument`) but are **not yet wired** to Collab sync. Presence and CRDT sync are separate concerns today.

---

### 4.7 Error Handling (`src/error/`)

**What it is:** A single source of truth for typed errors, public error mapping, deadlines, retries, and circuit breakers.

**Key exports:**
- `HubError` base class with `code: RealtimeErrorCode`.
- Subclasses: `AuthenticationError`, `AuthorizationError`, `ChannelError`, `MessageTooLargeError`, `ConnectionLimitError`, `ConnectionClosedError`, `ConnectionError`, `UnauthenticatedError`, `ForbiddenError`, `ValidationFailedError`, `VersionUnsupportedError`, `RateLimitedError`, `RoomFullError`, `OverloadedError`, `RoomNotFoundError`, `NamespaceNotFoundError`, `DocumentNotFoundError`, `EventTimeoutError`, `DeliveryFailedError`, `RetryExhaustedError`, `DocumentForbiddenError`, `CrdtInvalidOperationError`, `TenantIsolationError`, `RoomCapacityError`, `DocumentError`, `RoomError`, `CleanupError`, `AuthenticationTimeoutError`, `ConnectionNotAuthenticatedError`.
- `ErrorRegistry` + `globalRegistry` + `mapError` / `toPublicError` / `serializePublicError` / `generateRequestId`.
- `withDeadline` / `DeadlineExceededError`, `withRetry` / `isRetryableError` / `retryAfterMsOf` / `computeBackoffMs`.
- `CircuitBreaker` / `CircuitBreakerError`.

**Design:** Errors are mapped through the registry to a safe `PublicError` allowlist; internal details never leak to clients. Deadlines and retries exist but are internal — not yet exposed as `RealtimeHubOptions` fields.

---

### 4.8 Top-Level Exports (`src/index.ts`)

The root barrel re-exports everything:

- `RealtimeHub`, `createRealtimeHub`, `decodeMessage`, `CONNECTION_OPEN`, `DEFAULT_LIMITS`, `DEFAULT_HEARTBEAT`, `DEFAULT_BACKPRESSURE`
- Error classes: `RealtimeError`, `ConnectionError`, `ConnectionClosedError`, `ChannelError`, `AuthenticationError`, `AuthorizationError`, `MessageTooLargeError`, `ConnectionLimitError`
- Transport: `attachWebSocketAdapter`, `createConnectionAdapter`, `matchesPath`
- E2EE: key helpers, `EnvelopeService`, error classes, `ReplayGuard`
- Legacy: `Hub`, `AuthProvider`
- Core types: `ClientConnection`, `ConnectionState`, `Principal`, `TransportConnection`, `PublishResult`, `HubConfig`, `ClientEvent`
- All E2EE, error, collab, and event types
- `src/types.ts` barrel types

**Known issue:** ~120 flat exports, no `package.json` `exports` map, no tree-shaking separation, server-only deps (`libsodium-wrappers`, `uwebsocket`) load in browser bundles. Subpath exports (`/client`, `/adapter`, `/protocol`, `/e2ee`, `/errors`, `/event`, `/collab`) do not exist yet.

---

## 5. Examples (Current State)

Three examples exist, all converted to `createRealtimeHub` during the latest DX work:

| Example | Port | Transport | Notes |
|---|---|---|---|
| `examples/uws-chat.ts` | 3002 | uWS v20 (default) | Canonical uWS example. `attachWebSocketAdapter({ hub, port, path, ... })` |
| `examples/chat-express.ts` | 3010 | `ws` + Express HTTP server | Uses `server` option; serves HTML on `/`, WS on `/ws/chat` |
| `examples/chat-fastify.ts` | 3020 | `ws` + Fastify HTTP server | Uses `server` option; serves HTML on `/`, WS on `/ws/chat` |

**Common patterns in examples:**
- `authenticate` returns `{ name }` from `?name=` query param.
- `authorize` allows non-private channels; `private:<name>` only for matching name.
- `onConnection` sends `welcome` (with `text` field) and broadcasts `presence joined` excluding sender.
- `onMessage` requires `{ type: "message", text }`; replies `{ type: "error", message: "unknown message type" }` otherwise.
- All frames are **notepack binary** (`notepack.encode`/`decode`).
- `safeSend()` used everywhere — checks `readyState === OPEN` before sending, swallows send failures.

**Browser clients** decode with `notepack.decode(bytes)` from the unpkg CDN (`notepack.io@^3.0.1`).

---

## 6. TypeScript Contracts

### 6.1 Connection contract (the transport boundary)

```ts
interface Connection {
  readonly readyState: number;      // CONNECTION_OPEN = 1
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  readonly bufferedAmount?: number;
  ping?(): void;
}
```

### 6.2 Client snapshot (immutable view)

```ts
interface Client {
  readonly id: string;
  readonly connection: Connection;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly joinedAt: number;
  readonly lastSeenAt: number;
  readonly channels: ReadonlySet<string>;
}
```

### 6.3 Auth / authorize hooks

```ts
type RealtimeAction = "connect" | "join" | "leave" | "send" | "broadcast";

interface AuthenticateContext {
  connection: Connection;
  request?: unknown;
}
type AuthenticateHook = (context: AuthenticateContext) => Record<string, unknown> | void | Promise<...>;

interface AuthorizeContext {
  action: RealtimeAction;
  channel?: string;
  client?: Client;
  metadata?: Readonly<Record<string, unknown>>;
}
type AuthorizeHook = (context: AuthorizeContext) => boolean | void | Promise<boolean | void>;
```

### 6.4 Events

```ts
type RealtimeEventName =
  | "connect" | "disconnect" | "join" | "leave" | "send" | "drop" | "broadcast" | "reject";

interface RealtimeEvent {
  name: RealtimeEventName;
  clientId?: string;
  channel?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  at: number;
}
```

### 6.5 Broadcast options

```ts
interface BroadcastOptions {
  exclude?: Iterable<string>;
  include?: Iterable<string>;
  metadata?: Record<string, unknown>;
  authorizeRecipients?: boolean;
}
```

### 6.6 E2EE frame

```ts
interface E2EEFrame {
  type: "e2ee";
  ciphertext: string; // Base64
}
```

---

## 7. What Is NOT in This Package (Non-Goals)

- **No broker / multi-instance.** Cross-instance propagation is external.
- **No HTTP long-polling or SSE.** WebSocket only.
- **No client SDK in the root package.** `@oneunit/realtime/client` is planned, not implemented.
- **No automatic E2EE.** `e2ee: true` generates keys; developers must call `sendEnvelope()`/`broadcastEncrypted()` explicitly.
- **No role-based ACL out of the box.** `AllowAllAcl` is the only shipped collab policy; chat `authorize` is example-specific.

---

## 8. Improvement Roadmap (Phased)

### Phase 0 — Audit & Contracts (done)
- Inventoried all public exports; mapped `Hub` vs `RealtimeHub` differences.

### Phase 1 — Canonical Runtime (done)
- `createRealtimeHub` is the canonical runtime; examples converted.
- `Hub` remains but is effectively deprecated.

### Phase 2 — Ergonomics (in progress)
- `Channel<TMessage>` abstraction, typed events, standardized delivery results — planned in `docs/public-api-improvement-plan.md`.

### Phase 3 — Protocol (next)
- `src/protocol/` with `encodeFrame`/`decodeFrame`; JSON default + MessagePack optional; `@oneunit/realtime/protocol` subpath.

### Phase 4 — Transport & Reliability
- `Connection.send` → `Promise<void>`; safe-send core contract; uWS/`ws` consistency; backpressure tests.

### Phase 5 — Client SDK
- `@oneunit/realtime/client` — connect/reconnect, channels, presence, auth.

### Phase 6 — Docs & Examples
- Canonical browser-ready chat example; migration guide; restructured `docs/`.

### Phase 7 — Advanced
- Transparent E2EE, collab client WebSocket transport, role-based ACL, schema inference, observability.

---

## 9. Success Metrics

| Category | Target |
|---|---|
| Getting started | New developer runs an example in < 5 minutes; browser client connects with no custom protocol code |
| Consistency | One runtime, one client abstraction, one channel abstraction, consistent async contracts |
| TypeScript | No unnecessary `any` in public signatures; strong message inference; typed events |
| Reliability | Zero uncaught exceptions from malformed frames; no process crashes from failed sends; no cross-client interruption |
| Maintenance | Reduced duplicated runtime logic; shared protocol; consistent adapter tests |

---

## 10. Immediate Next Steps

1. Create `src/protocol/` with `encodeFrame`/`decodeFrame` (JSON + MessagePack codecs).
2. Add `Channel<TMessage>` abstraction to `createRealtimeHub`.
3. Add `package.json` `exports` map with subpaths: `/client`, `/adapter`, `/protocol`, `/e2ee`, `/errors`, `/event`, `/collab`.
4. Deprecate `Hub` with migration documentation.
5. Add browser-ready canonical example + client SDK.
