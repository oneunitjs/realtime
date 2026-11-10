# Platform Consolidation & Architecture Plan

**Version:** 2.0  
**Status:** Execution + design plan  
**Last updated:** 2026-11-07  
**Inputs:** `docs.zip`, `src.zip`, architecture series (Hub, Transport, Events, Presence, Rooms, E2EE, Error, Middleware, Collab, Implementation)

---

## Table of Contents

1. [Why This Plan Exists](#1-why-this-plan-exists)
2. [Goals and Non-Goals](#2-goals-and-non-goals)
3. [Current State (What Is Wrong Today)](#3-current-state-what-is-wrong-today)
4. [Target Architecture](#4-target-architecture)
5. [Transport Strategy: uWebSockets.js Only, Every HTTP Framework](#5-transport-strategy-uwebsocketsjs-only-every-http-framework)
6. [Core Runtime Design](#6-core-runtime-design)
7. [Public API & Developer Experience](#7-public-api--developer-experience)
8. [Documentation Consolidation](#8-documentation-consolidation)
9. [Source Consolidation: What to Keep, Merge, Delete](#9-source-consolidation-what-to-keep-merge-delete)
10. [Mechanisms Explained (How and Why)](#10-mechanisms-explained-how-and-why)
11. [Phased Execution Plan](#11-phased-execution-plan)
12. [Testing, Quality Gates, and Risks](#12-testing-quality-gates-and-risks)
13. [Definition of Done](#13-definition-of-done)
14. [Appendices](#14-appendices)

---

## 1. Why This Plan Exists

The codebase and docs currently describe **two products in one repository**:

1. A legacy **RealtimeHub** stack (channels, MessagePack, ad-hoc frame encryption, `ws`-style adapter).
2. A **spec-aligned Core Hub** stack (connection state machine, rooms, presence, delivery, envelope E2EE, error registry).

That dualism causes:

| Problem | Impact |
|---------|--------|
| Two hubs, two transports, two type systems | Contributors and consumers do not know which API is real |
| Docs duplicated as “spec” + “architecture plan” | Drift, contradictory names, slower reviews |
| Missing modules still imported (`error/`) | Broken or incomplete builds |
| Incomplete surfaces exported as public (`event/` types only) | DX lies about capabilities |
| Multiple WebSocket libraries | Extra surface area, inconsistent backpressure/close behavior |

This plan consolidates **architecture, code, transport, and public API** into one coherent platform that is:

- Correct relative to the architecture documents  
- Simple to embed in **Express, Fastify, Koa, bare Node `http`/`https`, and other Node servers**  
- Powered by **one** WebSocket engine: **uWebSockets.js**  
- Pleasant to use (DX-first public API)

---

## 2. Goals and Non-Goals

### 2.1 Goals

1. **Single runtime model** — one Hub, one connection lifecycle, one error registry, one E2EE envelope protocol.  
2. **Single WebSocket engine** — **uWebSockets.js only** (no `ws` as a supported production transport).  
3. **Framework-agnostic embedding** — same Hub works with Express, Fastify, Koa, Node HTTP, custom servers, and optionally a standalone uWS App.  
4. **Honest public API** — export only what is implemented; deprecate then delete dual APIs.  
5. **One architecture doc per domain** — delete redundant plan/spec pairs after merge.  
6. **Operational clarity** — backpressure, close ownership, heartbeats, and delivery semantics defined once and enforced in code.  
7. **DX** — small, typed, discoverable entrypoints; good defaults; explicit opt-in for advanced behavior.

### 2.2 Non-Goals (for this consolidation)

- Implementing the full custom CRDT engine in the same PR series (scheduled after Hub consolidation).  
- Claiming exactly-once delivery.  
- Supporting Bun/Deno as first-class hosts in v1 of consolidation (design should not preclude them later).  
- Keeping `RealtimeHub` as a permanent second product.

---

## 3. Current State (What Is Wrong Today)

### 3.1 Documentation

Almost every domain has **two** markdown files (spec-style + architecture-plan style), plus a **duplicate** root `collaboration-engine.md`. Content overlaps heavily; names and guarantees drift.

### 3.2 Source structure (from `src.zip`)

```text
src/
  index.ts              → exports BOTH RealtimeHub and Hub
  types.ts              → RealtimeHub world
  core/hub.ts           → RealtimeHub monolith (~1700 LOC)
  core/core-hub.ts      → Hub (~900 LOC) + service modules
  transport/adapter.ts  → legacy ws-oriented adapter
  transport/uws-*.ts, ws-*.ts, transport-adapter.ts
  security/e2ee.ts      → crypto helpers
  e2ee/*                → envelope protocol
  event/types.ts        → types only
  error/                → MISSING but imported everywhere
```

### 3.3 Transport confusion

- Legacy path assumes `ws`-like `WebSocketServer` / upgrade helpers.  
- Newer path already has uWS and `ws` implementations.  
- Public API still teaches both.  
- “Works with any server” is not clearly designed: upgrade ownership, fall-through, and proxy headers differ per framework.

### 3.4 Why this hurts DX

```ts
// Today a developer sees both:
import { createRealtimeHub, Hub, createConnectionAdapter, createTransportAdapter } from "pkg";
// Which one is correct? Which transport? Which E2EE?
```

Consolidation succeeds only when the happy path is obvious and the wrong path no longer exists.

---

## 4. Target Architecture

### 4.1 Logical diagram

```text
┌─────────────────────────────────────────────────────────────────┐
│                     Host HTTP application                        │
│         (Express | Fastify | Koa | node:http | other)            │
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTP only (REST, health, static)
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│                    uWebSockets.js (sole WS engine)               │
│         WS upgrade + frames + backpressure + ping/pong           │
└──────────────────────────────┬──────────────────────────────────┘
                               │ TransportConnection (normalized)
┌──────────────────────────────▼──────────────────────────────────┐
│                         Core Hub                                 │
│  Auth → Principal → Rooms → Events → Presence → Middleware       │
│  Error registry · Delivery · Disconnect coordinator              │
└───────┬─────────────────┬──────────────────┬────────────────────┘
        │                 │                  │
        ▼                 ▼                  ▼
   Collaboration      E2EE envelope      App handlers
   (ops / sync)       (route only)       (domain logic)
```

### 4.2 Package layout (target)

```text
src/
  index.ts                 # curated public API only
  hub/                     # Hub + services (today’s core/)
  transport/
    types.ts               # TransportConnection, AttachOptions
    uws-adapter.ts         # ONLY production WS implementation
    fake-transport.ts      # tests
    attach.ts              # Express/Fastify/Koa/http helpers
  error/
  e2ee/
  crypto/                  # libsodium primitives (from security/e2ee)
  event/
  presence/                # or nested under hub/
  rooms/
docs/                      # one architecture file per domain
```

### 4.3 Design principles

| Principle | Meaning |
|-----------|---------|
| Transport isolation | Hub never imports uWS; only `TransportConnection` |
| One engine | Production WebSocket = uWebSockets.js only |
| Host owns HTTP | Frameworks keep REST; WS is integrated, not a forced rewrite |
| Fail closed on protocol abuse | Oversized frames, bad Origin, auth timeout |
| Honest delivery | `send` ≠ received ≠ processed |
| Single-flight teardown | Disconnect/close runs once |

---

## 5. Transport Strategy: uWebSockets.js Only, Every HTTP Framework

### 5.1 Why uWebSockets.js only

| Reason | Explanation |
|--------|-------------|
| **Performance** | High connection counts and room fan-out are core workloads; uWS is consistently strong |
| **One backpressure model** | Dual `ws` + uWS meant two buffer behaviors, two close semantics, two bug classes |
| **Operational simplicity** | One pinned native dependency; one CI integration matrix for the engine |
| **Clear DX** | Docs say “this is how networking works,” not “pick a library” |

**Trade-off accepted:** hosts must load a native addon. That is normal for serious Node realtime servers. Pure-JS `ws` is **not** a supported production path after consolidation.

**Tests:** use in-memory `FakeTransport`, not `ws`.

### 5.2 The hard problem: working with Express, Fastify, Koa, and `http`

uWebSockets.js is not always a transparent drop-in on an existing Node `Server` the way `ws` is. The platform must document and implement **explicit integration patterns** instead of a vague `attach(server)` promise.

#### Pattern A — Reverse proxy split (most common in production)

```text
┌──────────── reverse proxy (nginx / caddy / cloud LB) ────────────┐
│  /api/*  →  Express | Fastify | Koa | http   (HTTP)              │
│  /ws     →  uWebSockets.js listener          (WebSocket)         │
└──────────────────────────────────────────────────────────────────┘
```

**Why:** Clean ownership. Framework never sees upgrades. uWS never fights framework middleware. Scales and cert termination stay at the proxy.

**How:** `createHubListener({ hub, path: "/ws", port })` (or shared process with two binds behind the proxy).

#### Pattern B — Shared Node process, path-based upgrade (DX for local/dev and many apps)

1. User creates their framework app as today.  
2. User creates a Node `http.Server` (or uses Fastify’s `.server`).  
3. `attachHubToServer(server, { hub, path: "/ws", ... })` installs **only** the WebSocket upgrade handler for that path.  
4. Non-matching requests continue to Express/Fastify/Koa/http handlers.  
5. Adapter validates Origin, size limits, optional subprotocol; creates `TransportConnection`; calls `hub.connect(transport, credential)`.

**Why:** One port in development; one deployable unit without mandatory proxy config.

**Constraints (must be documented honestly):**

- Behavior depends on the **pinned** uWebSockets.js version and how upgrade is bridged to Node’s `Server`.  
- If a given Node/uWS combination cannot safely share the server, docs fall back to Pattern A — **no silent half-support**.  
- Adapter must **not** destroy upgrades it does not own (fall-through).

#### Pattern C — Standalone uWS App

Full uWS HTTP + WS for services that do not need Express/Fastify. Useful for dedicated realtime nodes.

### 5.3 Normalized contract

```ts
interface TransportConnection {
  readonly id: string;
  /** Accepted into local buffer — NOT peer receipt. */
  send(data: Uint8Array): Promise<void>;
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: Uint8Array) => void): () => void;
  onClose(handler: (code: number, reason: string) => void): () => void;
  bufferedBytes(): number;
  readonly remoteAddress?: string;
}
```

Hub talks **only** to this interface. Swapping test fakes does not require Hub changes.

### 5.4 Attach API (what developers actually call)

```ts
// Standalone / Pattern A or C
createHubListener({
  hub,
  path: "/ws",
  port: 9001,
  origins: ["https://app.example.com"],
  maxPayloadBytes: 64_000,
});

// Pattern B — Express / Koa / http / Fastify.server
attachHubToServer(server, {
  hub,
  path: "/ws",
  origins: allowlist,
  getCredential: (req) => tokenFromQueryOrHeader(req),
});

// Thin wrappers (same mechanism)
await fastify.register(fastifyHubPlugin, { hub, path: "/ws" });
```

### 5.5 What we delete from transport

- Supported production **`ws`** transport (`ws-transport.ts`).  
- Legacy `createConnectionAdapter` / `attachWebSocketAdapter`.  
- Docs that say “any WebSocket library.”

---

## 6. Core Runtime Design

### 6.1 Single Hub

**Survive:** `Hub` (`core-hub.ts` + services under `core/*`).  
**Deprecate → delete:** `RealtimeHub` (`hub.ts`).

Responsibilities:

1. State machine: `connecting → authenticating → authenticated → closing → closed`  
2. Auth deadline + `Principal` from verified credentials only  
3. Room join/leave (capacity + AuthZ)  
4. Publish via router/delivery  
5. Heartbeat expiry → single-flight disconnect  
6. Middleware at connection / join / inbound event boundaries  
7. Optional E2EE envelope **validation** (not decryption in server-blind mode)

### 6.2 Service map

| Service | Role |
|---------|------|
| ConnectionRegistry | id → connection |
| AuthProvider | credential → Principal |
| RoomMembershipService | atomic capacity, idempotent membership |
| PresenceService + HeartbeatService | leases + aggregates |
| DeliveryService / Router | fan-out, optional ACK |
| DisconnectCoordinator | ordered, once |
| MiddlewareRunner | `next()` at most once |
| DocumentSubscriptionService | collab subscriptions (not CRDT merge) |

### 6.3 Errors

Restore `src/error/` as the only taxonomy. Public shape:

```ts
{ code, message, retryable, requestId?, retryAfterMs? }
```

### 6.4 E2EE

- Protocol in `e2ee/`.  
- Primitives moved to `crypto/`.  
- Required-room policy rejects plaintext and unkeyed joins.

---

## 7. Public API & Developer Experience

### 7.1 DX principles

| Principle | Practice |
|-----------|----------|
| One obvious entry | `createHub()` + `attachHubToServer()` / `createHubListener()` |
| Types match architecture | `Principal`, `Hub`, `PublicError`, `TransportConnection` |
| Safe defaults | Auth for join; max payload; Origin required in production |
| Progressive disclosure | Middleware, delivery mode, E2EE opt-in |
| Honest exports | No “delivery API” until implemented |
| Actionable errors | Registry codes + `requestId` |
| Framework recipes | Copy-paste Express / Fastify / Koa / http |

### 7.2 Happy paths

**Express**

```ts
import http from "node:http";
import express from "express";
import { createHub, attachHubToServer } from "@your/realtime";

const app = express();
app.get("/health", (_req, res) => res.send("ok"));

const hub = createHub({
  auth: (credential) => verifyJwt(credential),
  origins: [process.env.APP_ORIGIN!],
});

const server = http.createServer(app);
attachHubToServer(server, {
  hub,
  path: "/ws",
  getCredential: (req) => new URL(req.url ?? "", "http://x").searchParams.get("token") ?? undefined,
});
server.listen(3000);
```

**Fastify**

```ts
import Fastify from "fastify";
import { createHub, attachHubToServer } from "@your/realtime";

const fastify = Fastify();
const hub = createHub({ auth: verifyJwt, origins: [...] });
await fastify.ready();
attachHubToServer(fastify.server, { hub, path: "/ws", getCredential });
await fastify.listen({ port: 3000 });
```

**Koa**

```ts
import http from "node:http";
import Koa from "koa";
import { createHub, attachHubToServer } from "@your/realtime";

const app = new Koa();
const hub = createHub({ auth: verifyJwt, origins: [...] });
const server = http.createServer(app.callback());
attachHubToServer(server, { hub, path: "/ws", getCredential });
server.listen(3000);
```

**Bare `http`**

```ts
import http from "node:http";
import { createHub, attachHubToServer } from "@your/realtime";

const hub = createHub({ auth: verifyJwt, origins: [...] });
const server = http.createServer((req, res) => { res.writeHead(200); res.end("ok"); });
attachHubToServer(server, { hub, path: "/ws", getCredential });
server.listen(3000);
```

### 7.3 Curated `index.ts` exports

```ts
export { createHub, Hub } from "./hub/index.js";
export type { HubOptions, HubMetrics, ClientConnection, Principal } from "./hub/types.js";

export {
  attachHubToServer,
  createHubListener,
  fastifyHubPlugin,
} from "./transport/attach.js";
export type { AttachOptions, TransportConnection } from "./transport/types.js";

export { HubError, toPublicError, ErrorCodes } from "./error/index.js";
export type { PublicError, ErrorCode } from "./error/index.js";

export { EnvelopeService, /* protocol types */ } from "./e2ee/index.js";
export { generateKeyPair, /* advanced */ } from "./crypto/index.js";
```

**Not exported:** `RealtimeHub`, `createRealtimeHub`, `ChannelImpl`, legacy adapters, primary “shared key frame” helpers.

### 7.4 `createHub` defaults (suggested)

```ts
{
  authDeadlineMs: 10_000,
  maxPayloadBytes: 64_000,
  heartbeat: { intervalMs: 25_000, timeoutMs: 75_000 },
  origins: requiredWhenNodeEnvProduction,
}
```

---

## 8. Documentation Consolidation

**Rule:** one architecture file per domain; one implementation plan; public API doc matches §7.

| Action | Detail |
|--------|--------|
| Merge | Spec + plan pairs; keep unique diagrams/exit criteria |
| Delete | Weaker duplicate; root collab duplicate; redundant platform implementation plan if identical |
| Rewrite | Transport doc → uWS-only + Patterns A/B/C + framework recipes |
| Add | `migration-from-realtimehub.md` (temporary) |
| Align | Error codes and type names with TypeScript |

---

## 9. Source Consolidation: What to Keep, Merge, Delete

### Keep / complete

- `Hub` + services  
- uWS adapter + `attach.ts` + FakeTransport  
- `e2ee/*` protocol  
- `crypto/*` (moved primitives)  
- Restored `error/*`  
- `event/*` only as public when delivery exists  

### Delete after deprecation

- `core/hub.ts`  
- `transport/adapter.ts`  
- `transport/ws-transport.ts`  
- Dual root exports  
- Redundant docs  

### Merge

- Connection types → `ClientConnection` / `Principal`  
- Heartbeat config shared with presence leases  
- All errors through registry  

---

## 10. Mechanisms Explained (How and Why)

### 10.1 Connection lifecycle

**Why:** Tabs sleep, proxies drop idle sockets, users refresh. Async joins must not complete on a dead connection.  

**How:** Explicit states; auth deadline; `AbortController`; join/publish only when `authenticated`; teardown moves to `closing` synchronously.

### 10.2 Single-flight disconnect

**Why:** Heartbeat, remote close, and API `disconnect()` race.  

**How:** Coordinator flag per connection; idempotent membership/presence/delivery cleanup; transport `close` once.

### 10.3 Room capacity

**Why:** Last slot concurrent joins.  

**How:** Atomic reserve before await; rollback on failure; idempotent `(roomKey, connectionId)`.

### 10.4 Backpressure

**Why:** Slow mobile clients + large rooms.  

**How:** `bufferedBytes()` soft stop / hard close; ephemeral drop; reliable path returns typed overload errors.

### 10.5 Presence leases

**Why:** Multi-device users.  

**How:** Per-device TTL; deterministic aggregate; disconnect one device ≠ offline user.

### 10.6 E2EE routing

**Why:** Server-blind threat model.  

**How:** Envelope validate + route; no server decrypt; epoch on revoke; required policy blocks unkeyed members.

### 10.7 Middleware

**Why:** Cross-cutting authz/limits without scattering checks.  

**How:** Ordered pipelines; `next()` once; short-circuit sets explicit error; identity fields immutable after auth stage.

### 10.8 Host + uWS integration

**Why:** Teams will not abandon Express/Fastify for realtime.  

**How:** Patterns A/B/C; path-scoped upgrade; Origin and payload limits at the edge; Hub receives only `TransportConnection`; integration test matrix per framework.

### 10.9 Why not abstract “any WebSocket library”

**Why we refuse:** Each library’s upgrade, ping, and buffer semantics leak. Dual support recreated the current mess.  

**How we still test:** FakeTransport for unit tests; one native engine for integration.

---

## 11. Phased Execution Plan

| Phase | Focus | Exit criteria |
|-------|--------|----------------|
| **0** | Lock uWS-only + attach patterns + API sketch | ADR / plan section approved |
| **1** | Restore `error/`, typecheck, import graph | `tsc` green |
| **2** | Docs merge/delete; transport + public API rewrite | One doc per domain |
| **3** | uWS adapter + `attachHubToServer` + framework tests | Express/Fastify/Koa/http recipes pass |
| **4** | `createHub`; deprecate RealtimeHub; migrate tests | Hub is default in docs/examples |
| **5** | Crypto move; single E2EE story | No dual frame-crypto path |
| **6** | Delete RealtimeHub, legacy adapter, ws transport | `rg` clean |
| **7** | Event honesty; benchmarks on uWS | Public API ⊆ implemented features |
| **8** | Security review, soak, runbooks | Production checklist signed |

**Priority if time-boxed:** 1 → 3 (Express+http) → 4 → 6 → 2 → Fastify/Koa matrix → 5 → 7.

---

## 12. Testing, Quality Gates, and Risks

### Tests

- Attach success matrix (Express, Fastify, Koa, http)  
- Bad Origin, wrong path fall-through, oversize frame  
- Auth timeout / fail / disconnect during auth  
- Double disconnect, heartbeat expiry, listener cleanup  
- Room capacity race, presence multi-device, E2EE tamper/replay  
- Backpressure soft/hard  

### Gates

- `tsc`, unit/integration  
- eslint `no-restricted-imports` on legacy symbols  
- Pin uWS version; test against that version  
- No public export without implementation  

### Risks

| Risk | Mitigation |
|------|------------|
| uWS + shared `Server` quirks | Honest docs; Pattern A fallback; version-pinned tests |
| Native addon install | `engines` field; clear load error |
| Breaking RealtimeHub apps | Deprecation window + migration guide |
| CRDT scope creep | Phase boundary |

---

## 13. Definition of Done

1. Production WebSocket engine is **only** uWebSockets.js.  
2. Tested attach recipes for **Express, Fastify, Koa, Node http**.  
3. Single Hub + `createHub` factory.  
4. Single error registry and public error shape.  
5. Single E2EE envelope protocol; primitives under `crypto/`.  
6. No `RealtimeHub`, legacy `adapter.ts`, or supported `ws` transport.  
7. One architecture doc per domain + public API recipes matching code.  
8. A new developer can paste a framework recipe and get auth + safe defaults without reading uWS docs.  
9. CI enforces typecheck, tests, and restricted imports.

---

## 14. Appendices

### A — Why drop `ws`

Keeping `ws` doubles close/ping/backpressure bugs and CI cost. FakeTransport covers unit tests; uWS covers production.

### B — Quick grep checklist

```bash
rg -n "RealtimeHub|createRealtimeHub|ChannelImpl|createConnectionAdapter|ws-transport|from \"ws\"" src
rg -n "encryptWithSharedKey|E2EEFrame" src
```

### C — Related architecture docs

Core Hub, Transport, Middleware, Rooms, Presence, Events, Error Handling, E2EE, Collaboration Engine, Implementation Plan — after consolidation, each should exist **once** and match this plan’s names and transport decision.

---

*This document is the authoritative consolidation, transport-direction, and public-API plan. Prefer deleting the legacy path and completing the Hub + uWS path over maintaining two products indefinitely.*
