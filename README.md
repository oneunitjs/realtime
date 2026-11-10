# `@oneunit/realtime`

<p align="center">
  <strong>Production-grade, single-process realtime WebSocket infrastructure for Node.js.</strong>
  <br/>
  In-memory channels · uWebSockets.js transport · Adaptive backpressure · Shared heartbeat timer<br/>
  Verified auth hooks · Browser-safe client SDK · Libsodium E2EE · In-process CRDT collaboration
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@oneunit/realtime"><img src="https://img.shields.io/npm/v/@oneunit/realtime?color=0969da&label=npm" alt="npm version"></a>
  <a href="https://github.com/oneunitjs/realtime/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@oneunit/realtime?color=22863a" alt="license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-417e38" alt="node version">
  <img src="https://img.shields.io/badge/types-included-3178c6" alt="types included">
  <img src="https://img.shields.io/badge/engine-uWebSockets.js%20v20-8a2be2" alt="engine">
</p>

---

## Table of Contents

- [Overview](#overview)
  - [What It Is](#what-it-is)
  - [What It Is NOT](#what-it-is-not)
- [Primary Use Cases](#primary-use-cases)
- [Key Advantages & Unique Selling Points](#key-advantages--unique-selling-points)
- [Installation](#installation)
- [Granular Subpath Imports](#granular-subpath-imports)
- [Quick Start](#quick-start)
- [Comprehensive Implementation Guide](#comprehensive-implementation-guide)
  - [1. Creating the Realtime Server](#1-creating-the-realtime-server)
  - [2. Connecting via the First-Party Client SDK](#2-connecting-via-the-first-party-client-sdk)
  - [3. Authentication & Principal Verification](#3-authentication--principal-verification)
  - [4. Fine-Grained Authorization Hooks](#4-fine-grained-authorization-hooks)
  - [5. Working with Rooms (Channels) & Fan-out](#5-working-with-rooms-channels--fan-out)
  - [6. Collaborative Documents & State Synchronization](#6-collaborative-documents--state-synchronization)
  - [7. Multi-Device Presence & Awareness Tracking](#7-multi-device-presence--awareness-tracking)
  - [8. In-Process CRDT Collaborative Editing](#8-in-process-crdt-collaborative-editing)
  - [9. End-to-End Encryption (E2EE) with Libsodium](#9-end-to-end-encryption-e2ee-with-libsodium)
  - [10. HTTP Framework Integration (Express, Fastify, Koa, node:http)](#10-http-framework-integration-express-fastify-koa-nodehttp)
  - [11. Capacity Limits, Rate Limiting & Backpressure](#11-capacity-limits-rate-limiting--backpressure)
  - [12. Heartbeat & Liveness Sweeper](#12-heartbeat--liveness-sweeper)
  - [13. Observability, Telemetry & Health Checks](#13-observability-telemetry--health-checks)
  - [14. Graceful Teardown & Drain Sequence](#14-graceful-teardown--drain-sequence)
- [Horizontal Scaling & Multi-Node Federation](#horizontal-scaling--multi-node-federation)
- [Error Handling & Error Code Dictionary](#error-handling--error-code-dictionary)
- [Runnable Examples](#runnable-examples)
- [Technical Architecture](#technical-architecture)
- [Verification & Development](#verification--development)
- [License](#license)

---

## Overview

### What It Is

`@oneunit/realtime` is a **high-throughput, transport-neutral, single-process realtime runtime for Node.js (20+)**. Built from the ground up for mission-critical applications, it provides everything needed to power modern interactive applications in a single Node process:

- **Transport-Independent Core Engine**: The core hub operates entirely on an abstract `TransportConnection` contract. It has zero coupling to WebSockets, HTTP frameworks, or concrete transport sockets, making your core business logic purely testable in memory.
- **Kernel-Grade uWebSockets.js Engine**: Native C++ event loop integration via `uWebSockets.js` v20 delivers high I/O throughput, low-latency fan-out, and minimal memory consumption under tens of thousands of concurrent connections.
- **In-Memory Channel & Document Mesh**: High-performance local pub/sub, room subscription management, and document state fan-out with configurable sender echo behavior.
- **Multi-Device Presence & Awareness**: Track user leases across multiple browser tabs and devices with aggregated online/idle statuses, live typing indicators, and cursor positions.
- **Zero-Trust Security & Pre-Handshake Auth**: Connections are strictly authenticated before socket promotion or membership admission. Fine-grained async authorization gates every join, read, write, and publish action.
- **Deterministic Backpressure & Resource Bounds**: Protection against slow consumers, memory leaks, and buffer bloat via per-connection queue caps, frame size validation, and graceful backpressure drops.
- **Single O(N) Shared Heartbeat Sweeper**: Sweeps all registered sockets from a single unref'd timer loop, eliminating per-socket timer allocations and avoiding event loop degradation.
- **Native CRDT Collaboration**: Integrated Conflict-free Replicated Data Types (RGA for text, LWW-Map for metadata) with Vector Clocks for causal consistency.
- **Provable End-to-End Encryption (E2EE)**: Optional zero-knowledge Libsodium envelope encryption (X25519, HKDF-SHA-256, XSalsa20-Poly1305, Ed25519). The hub routes encrypted ciphertext envelopes blindly without ever holding keys or decrypting payloads.
- **Browser-Safe Client SDK**: A full-featured client SDK (`@oneunit/realtime/client`) with zero server dependencies, automatic reconnect with jittered exponential backoff, typed channels, and presence hooks.

```
   Browser / Native Clients / SDK
                  │  (WebSocket: JSON or MessagePack)
                  ▼
  ┌────────────────────────────────────────────────────────┐
  │  Transport Layer: uWebSockets.js v20 (Dedicated/Native)│
  │  - Fast C++ TCP / HTTP Upgrade Engine                 │
  │  - Immediate ArrayBuffer Memory Safety Copy            │
  └───────────────────────┬────────────────────────────────┘
                          │ TransportConnection Contract
                          ▼
  ┌────────────────────────────────────────────────────────┐
  │  Core Hub Runtime (Zero Transport / Zero Broker Deps)  │
  │  - Pre-Handshake Auth & Async Authorization Gates      │
  │  - Connection Registry & Idempotent Disconnect State   │
  │  - Room / Channel Membership & Dynamic Capacity Bounds │
  │  - Presence & Awareness Lease Aggregation              │
  │  - FanoutScheduler (Bounded Outbound Queues)           │
  │  - Libsodium E2EE Blind Envelope Router                │
  │  - CRDT Collaboration Synchronization Engine           │
  │  - Single Shared Heartbeat Sweeper Timer               │
  └───────────────────────┬────────────────────────────────┘
                          │ BroadcastTarget (Optional)
                          ▼
             External Broker Adapter (Yours)
             [Redis Pub/Sub / NATS / Kafka / AMQP]
```

### What It Is NOT

- **Not a distributed broker:** There is no Kafka, Redis, RabbitMQ, or NATS client bundled into this package. The hub is intentionally single-process. If you scale across multiple processes or containers, you wire an external broker to the hub's `BroadcastTarget` interface in just a few lines of code.
- **Not a black-box opinionated framework:** It does not dictate database models, ORMs, dependency injection schemes, or session stores. You provide simple async hooks for authentication and authorization.
- **Not a TLS replacement:** E2EE provides cryptographic payload confidentiality against wire observers and blind server operators. It does not replace transport security. Always serve production traffic over `wss://`.

---

## Primary Use Cases

1. **Enterprise Chat & Team Messaging**: Multi-room chat, direct 1-to-1 conversations, thread fan-out, message history delivery, and read receipts with high concurrency and low memory usage.
2. **Real-Time Collaborative Workspaces**: Google Docs or Figma-style co-editing powered by the built-in CRDT engine (convergent text via RGA, conflict-free metadata via LWW-Map, and causal tracking via Vector Clocks).
3. **Live Presence & Ephemeral Awareness**: Real-time user statuses ("online", "idle", "busy"), live typing indicators, and multi-user cursor tracking synchronized across browser viewports.
4. **Privacy-Critical & Zero-Knowledge Applications**: Regulated messaging (healthcare, finance, enterprise communications) where the server must route encrypted envelopes blindly without accessing plaintext.
5. **High-Frequency Live Dashboards & Push Feeds**: Financial market feeds, sports scores, IoT telemetry, and live auction platforms that require sub-millisecond fan-out and strict backpressure isolation.
6. **Edge WebSocket Termination Gateways**: High-performance ingress instances running uWebSockets.js that terminate many long-lived client sockets, authenticate requests at the edge, and feed backend systems.

---

## Key Advantages & Unique Selling Points

| Feature | `@oneunit/realtime` | Standard `ws` / `Socket.io` |
|---|---|---|
| **Core Architecture** | Fully transport-neutral hexagonal design | Hard-coded to specific socket implementations |
| **WebSocket Engine** | Native C++ `uWebSockets.js` v20 | Pure JavaScript Node `ws` engine |
| **Backpressure Handling** | Explicit per-socket queue limits & backpressure drops | Unbounded internal memory buffer growth |
| **Heartbeat Model** | Single O(N) unref'd timer for all connections | Per-socket `setInterval` timers (event loop strain) |
| **Authorization** | Fine-grained async hooks per action (`join`, `publish`, etc.) | Ad-hoc middleware or socket-level only |
| **Client Identity** | Verified `Principal` bound at handshake | Arbitrary client claims trusted in messages |
| **Encryption** | Native Libsodium E2EE envelope routing | Must be implemented manually from scratch |
| **Collaboration** | Built-in CRDT engine (RGA, LWW-Map, Vector Clocks) | Requires separate Yjs/Automerge integration |
| **Presence Engine** | Ephemeral device lease aggregation with TTL expiry | Simple set/map of connection IDs |
| **Packaging** | Zero-leak granular subpath exports with browser-safe client | Monolithic bundle mixing client and server code |

---

## Installation

```bash
npm install @oneunit/realtime
```

**System Requirements:**
- **Node.js**: `v20.0.0` or higher (LTS recommended)
- **Architecture**: Linux (x64, arm64), macOS (Apple Silicon, Intel), or Windows (x64) supported by `uWebSockets.js` binaries.

---

## Granular Subpath Imports

`@oneunit/realtime` provides modular subpath exports so consumers import only the exact dependencies and surfaces required:

```typescript
// 1. Full public server facade (uWS transport, hub, errors)
import { createRealtime, anonymousAuthProvider } from "@oneunit/realtime";

// 2. Core Hub only (Zero WebSocket or uWS dependencies - pure in-memory)
import { Hub, createHub } from "@oneunit/realtime/hub";

// 3. Browser-safe Client SDK (Zero server/uWS dependencies)
import { createRealtimeClient } from "@oneunit/realtime/client";

// 4. Low-level Transport Adapter & contracts
import { UwsTransportAdapter, createUwsTransport } from "@oneunit/realtime/adapter";

// 5. CRDT Collaborative Engine
import { CollaborationEngine, RGA, VectorClock } from "@oneunit/realtime/collab";

// 6. End-to-End Encryption (Libsodium)
import { EnvelopeService, generateDeviceKeys } from "@oneunit/realtime/e2ee";

// 7. Presence & Awareness Subsystem
import { PresenceService, MemoryPresenceStore } from "@oneunit/realtime/presence";

// 8. Room & Namespace Management
import { RoomNamespaceRouter, NamespaceManager } from "@oneunit/realtime/room-namespace";

// 9. Protocol Codecs & Envelopes (JSON and MessagePack)
import { encodeFrame, decodeFrame, jsonCodec, messagepackCodec } from "@oneunit/realtime/protocol";

// 10. Typed Errors & Resilience Utilities
import { HubError, ConnectionLimitError, CircuitBreaker } from "@oneunit/realtime/errors";

// 11. Framework Lifecycle Integrations
import { expressRealtime, fastifyRealtime, koaRealtime, nodeHttpRealtime } from "@oneunit/realtime/express"; // or /fastify, /koa, /node-http
```

---

## Quick Start

### 1. Minimal Server

Create a standalone realtime server listening on port `4001`:

```typescript
import { createRealtime, anonymousAuthProvider } from "@oneunit/realtime";

const realtime = createRealtime({
  port: 4001,
  path: "/ws",
  // Accept connections anonymously for development
  authenticate: anonymousAuthProvider.authenticate,
});

await realtime.listen();
console.log(`Server listening on ${realtime.wsUrl}`);
// ws://127.0.0.1:4001/ws
```

### 2. Connect with the Client SDK

Connect to the server from a browser or Node client, join a room, and exchange typed messages:

```typescript
import { createRealtimeClient } from "@oneunit/realtime/client";

const client = createRealtimeClient({
  url: "ws://127.0.0.1:4001/ws",
  codec: "json", // or "messagepack"
  auth: {
    token: async () => "user-token-123",
  },
});

await client.connect();

// Join the "general" chat channel
const chat = client.channel<{ user: string; text: string }>("general");

chat.onMessage((message) => {
  console.log(`[${message.user}]: ${message.text}`);
});

await chat.join();
await chat.send({ user: "Alice", text: "Hello from the client SDK!" });
```

---

## Comprehensive Implementation Guide

### 1. Creating the Realtime Server

The recommended entry point is `createRealtime(config)`. It sets up an optimized uWebSockets.js transport, binds it to the core Hub, and returns a `RealtimeServer` lifecycle controller:

```typescript
import { createRealtime } from "@oneunit/realtime";

const realtime = createRealtime({
  port: 4001,
  host: "0.0.0.0",
  path: "/ws",
  allowedOrigins: ["https://myapp.com", "http://localhost:3000"],
  
  // Custom capacity limits
  limits: {
    maxConnections: 25_000,
    maxPayloadBytes: 128 * 1024,        // 128 KiB frame ceiling
    maxBackpressureBytes: 512 * 1024,   // 512 KiB queue cap per socket
    authTimeoutMs: 5_000,               // 5s auth deadline
  },

  // Per-room participant limits
  roomCapacities: {
    "vip-lounge": 50,
    "general": 5_000,
  },

  // Authentication & Authorization hooks
  authenticate: async (context) => {
    const token = context.query.token ?? context.headers["authorization"]?.replace(/^Bearer\s+/i, "");
    if (!token) {
      throw new Error("Missing authentication token");
    }
    const session = await verifySessionToken(token);
    return {
      userId: session.userId,
      tenantId: session.tenantId,
      roles: session.roles,
      sessionId: session.id,
    };
  },

  authorize: async (action, principal, resourceId, tenantId) => {
    if (action === "room:join" && resourceId === "admin-channel") {
      return principal.roles?.includes("admin") ?? false;
    }
    return true;
  },
});

const address = await realtime.listen();
console.log(`Realtime gateway running at ${realtime.wsUrl}`);
```

---

### 2. Connecting via the First-Party Client SDK

The `@oneunit/realtime/client` module provides an isomorphic, browser-safe client with built-in auto-reconnect, protocol framing, and channel multiplexing:

```typescript
import { createRealtimeClient } from "@oneunit/realtime/client";

const client = createRealtimeClient({
  url: "wss://api.myapp.com/ws",
  codec: "messagepack", // High-efficiency binary serialization
  protocols: ["realtime-v1"],
  auth: {
    token: async () => {
      // Refresh or fetch your JWT bearer token
      return await getFreshAccessToken();
    },
  },
  reconnect: {
    enabled: true,
    maxAttempts: 15,
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
  },
});

// Lifecycle event monitoring
client.on("connected", () => console.log("Realtime connection established"));
client.on("disconnected", () => console.warn("Socket disconnected, retrying..."));
client.on("error", (err) => console.error("Realtime transport error:", err));

await client.connect();

// Type-safe Channel interactions
const room = client.channel<{ text: string; sender: string }>("project-updates");

const unsubscribeMessages = room.onMessage((msg) => {
  console.log("New broadcast received:", msg);
});

const unsubscribePresence = room.onPresence((presence) => {
  console.log("Room presence update:", presence);
});

await room.join();
await room.send({ text: "Task completed", sender: "Alice" });

// Clean teardown
// unsubscribeMessages();
// await room.leave();
// await client.close();
```

---

### 3. Authentication & Principal Verification

In `@oneunit/realtime`, **client payloads are never trusted as identity claims**. The server establishes identity strictly through the `authenticate` hook during the connection handshake:

```typescript
import { createRealtime, credentialFromHandshake } from "@oneunit/realtime";

const realtime = createRealtime({
  authenticate: async (context) => {
    // context: { path, headers, query, origin, remoteAddress, signal }
    const credential = credentialFromHandshake(context);
    
    if (!credential) {
      throw new Error("Missing authentication credentials");
    }

    const payload = await jwtVerify(credential, JWT_SECRET);

    // Return a strictly typed AuthenticatedPrincipal
    return {
      userId: payload.sub,
      tenantId: payload.tenant_id ?? "default",
      roles: payload.roles ?? ["user"],
      sessionId: payload.jti,
    };
  },
});
```

- If authentication succeeds, the principal is sealed to the connection record and a `welcome` frame is emitted.
- If authentication fails or exceeds `authTimeoutMs` (default 7.5s), the connection is closed immediately with WebSocket code `1008` (Policy Violation) and consumes no room slots.

---

### 4. Fine-Grained Authorization Hooks

Channel names are not passwords or permissions. Every protected action is intercepted and passed through your `authorize` hook before execution:

```typescript
const realtime = createRealtime({
  authorize: async (action, principal, resourceId, tenantId) => {
    // Check tenant boundary
    if (principal.tenantId !== tenantId) {
      return false; // Cross-tenant access strictly forbidden
    }

    switch (action) {
      case "room:join":
        // resourceId is the roomId
        if (resourceId.startsWith("private:")) {
          return await db.checkRoomAccess(principal.userId, resourceId);
        }
        return true;

      case "room:leave":
        return true; // Leaving is always permitted

      case "document:read":
        return await db.canReadDocument(principal.userId, resourceId);

      case "document:write":
        return principal.roles?.includes("editor") ?? false;

      case "event:publish":
        // Prevent muted users or guests from broadcasting
        return !principal.roles?.includes("muted");

      default:
        return false;
    }
  },
});
```

---

### 5. Working with Rooms (Channels) & Fan-out

Rooms are named local subscription groups for broadcasting messages:

```typescript
// Inspecting rooms programmatically on the server
const memberCount = realtime.hub.memberCount("chat-room-1");
const memberConnectionIds = realtime.hub.roomMembers("chat-room-1");

// Publishing directly from server-side business logic
const result = await realtime.hub.publish("server", {
  type: "message",
  channel: "chat-room-1",
  payload: { announcement: "Server maintenance in 10 minutes" },
  excludeSender: false, // Send to all members
});

console.log(`Delivered to ${result.status === "delivered" ? result.recipientCount : 0} clients`);
```

#### Publish Result Semantics

Publish operations return an explicit typed result (`PublishResult`), never a bare boolean or swallowed exception:

```typescript
type PublishResult =
  | { status: "delivered"; recipientCount: number }
  | { status: "partial"; delivered: number; failed: number }
  | { status: "rejected"; reason: string };
```

- **Sender Exclusion**: By default, publishes to rooms exclude the sender (`excludeSender: true`).
- **Bounded Delivery**: If any single recipient's socket buffer is congested, the write is dropped for that recipient without blocking or throwing for healthy recipients.

---

### 6. Collaborative Documents & State Synchronization

Documents represent shared state subscriptions (e.g., canvas elements, JSON state trees, document models). Unlike rooms, document subscriptions:
1. Carry explicit permissions (`read` or `write`).
2. **Include the sender by default** (`excludeSender: false`) so all collaborators see the converged state stream.

```typescript
// Subscribing a client to a document
await realtime.hub.subscribeDocument(connectionId, "doc-spreadsheet-99", "write");

// Publishing a document mutation
await realtime.hub.publish(connectionId, {
  type: "document:update",
  channel: "doc-spreadsheet-99",
  payload: { cell: "B12", value: 4200 },
});

// Unsubscribing
await realtime.hub.unsubscribeDocument(connectionId, "doc-spreadsheet-99");
```

---

### 7. Multi-Device Presence & Awareness Tracking

The `@oneunit/realtime/presence` subsystem provides production-ready presence tracking with multi-device aggregation, heartbeat leases, and ephemeral awareness signals:

```typescript
import { PresenceService, MemoryPresenceStore } from "@oneunit/realtime/presence";

const presenceStore = new MemoryPresenceStore();
const presence = new PresenceService({
  store: presenceStore,
  config: {
    heartbeatIntervalMs: 25_000,
    leaseTtlMs: 60_000,
    offlineGracePeriodMs: 15_000,
  },
});

// Record device heartbeat lease
await presence.heartbeat(
  { userId: "user-123", tenantId: "tenant-a", deviceId: "mobile-app" },
  { userAgent: "iOS-App/2.1", ip: "192.168.1.10" }
);

// Query aggregated user status (computes aggregate across phone + desktop)
const userPresence = await presence.getUserPresence("user-123");
console.log(userPresence.status); // "online" | "idle" | "offline"
console.log(userPresence.devices); // Array of active device leases

// Broadcast live ephemeral awareness (typing indicator, mouse cursor)
await presence.updateCursor(
  { userId: "user-123", tenantId: "tenant-a", deviceId: "tab-1" },
  "canvas-room-1",
  { x: 428, y: 712 }
);
```

---

### 8. In-Process CRDT Collaborative Editing

For concurrent real-time co-editing without operational transform (OT) complexity, `@oneunit/realtime/collab` implements a state-of-the-art Conflict-free Replicated Data Type:
- **RGA (Replicated Growable Array)**: High-performance causal character-level text editing.
- **LWW-Map (Last-Write-Wins Map)**: Conflict-free concurrent object attribute updates.
- **Vector Clocks**: Precise causal dependency tracking.

```typescript
import { CollaborationEngine } from "@oneunit/realtime/collab";

// Initialize an engine instance for a document
const engine = new CollaborationEngine({
  documentId: "doc-shared-notes",
  schemaVersion: 1,
  transport: clientTransport,
});

await engine.connect();

// Perform optimistic local edits (immediately reflected in UI)
await engine.insertText("ROOT", "Hello World!");
await engine.deleteText("ROOT", 5, 6); // Removes " World"

// Inspect converged plain text
console.log(engine.getText()); // "Hello!"

// Sync state snapshots
const snapshot = engine.exportSnapshot();
await engine.disconnect();
```

---

### 9. End-to-End Encryption (E2EE) with Libsodium

`@oneunit/realtime/e2ee` provides zero-knowledge cryptographic envelope routing. The server relays sealed ciphertext envelopes blindly without possessing user keys or decrypting payloads:

```typescript
import {
  createHub,
  EnvelopeService,
  generateDeviceKeys,
  e2eeReady,
} from "@oneunit/realtime";

// 1. Ensure Libsodium WASM/native runtime is initialized
await e2eeReady();

// 2. Generate cryptographic identity keypairs for clients
// Alice and Bob generate X25519 (ECDH) + Ed25519 (Signature) keys
const aliceKeys = generateDeviceKeys();
const bobKeys = generateDeviceKeys();

const envelopeService = new EnvelopeService();

// 3. Alice seals an encrypted envelope intended for Bob
const sealedEnvelope = await envelopeService.seal({
  plaintext: new TextEncoder().encode("Classified top-secret message"),
  recipientPublicKey: bobKeys.x25519PublicKey,
  senderX25519KeyPair: {
    publicKey: aliceKeys.x25519PublicKey,
    privateKey: aliceKeys.x25519PrivateKey,
  },
  senderEd25519KeyPair: {
    publicKey: aliceKeys.ed25519PublicKey,
    privateKey: aliceKeys.ed25519PrivateKey,
  },
  conversationId: "private-chat-room",
  senderUserId: "alice",
  senderDeviceId: aliceKeys.deviceId,
  keyEpoch: 1,
});

// 4. Server routes the envelope blindly (never sees plaintext)
await realtime.hub.sendEnvelope(aliceConnectionId, sealedEnvelope);

// 5. Bob opens the sealed envelope on his local device
const opened = await envelopeService.open({
  envelope: sealedEnvelope,
  recipientX25519PrivateKey: bobKeys.x25519PrivateKey,
  senderX25519PublicKey: aliceKeys.x25519PublicKey,
  senderEd25519PublicKey: aliceKeys.ed25519PublicKey,
  keyEpoch: 1,
});

console.log(new TextDecoder().decode(opened));
// "Classified top-secret message"
```

- **Primitives**: X25519 ECDH key agreement, HKDF-SHA-256 key derivation, XSalsa20-Poly1305 AEAD authenticated symmetric encryption, and Ed25519 digital signatures.
- **Fail-Closed Guarantee**: Malformed envelopes, untrusted keys, signature mismatches, or replay attempts throw typed `E2EEError` exceptions.

---

### 10. HTTP Framework Integration (Express, Fastify, Koa, node:http)

`uWebSockets.js` owns its own native C++ listener. It does **not** attach to a standard Node `http.Server` `upgrade` event. 

`@oneunit/realtime` provides lifecycle adapters that coordinate shutdown hooks with your HTTP framework:

#### Express Integration

```typescript
import express from "express";
import http from "node:http";
import { createRealtime } from "@oneunit/realtime";
import { expressRealtime } from "@oneunit/realtime/express";

const app = express();
const server = http.createServer(app);

// Start dedicated uWS WebSocket listener on port 4001
const realtime = createRealtime({ port: 4001, path: "/ws" });
await realtime.listen();

// Coordinate Express server close with Realtime draining & teardown
expressRealtime(app, realtime, { httpServer: server });

server.listen(3000, () => {
  console.log("Express HTTP listening on 3000, Realtime WebSocket on 4001");
});
```

#### Fastify Integration

```typescript
import Fastify from "fastify";
import { createRealtime } from "@oneunit/realtime";
import { fastifyRealtime } from "@oneunit/realtime/fastify";

const fastify = Fastify({ logger: true });
const realtime = createRealtime({ port: 4001, path: "/ws" });
await realtime.listen();

// Registers Fastify onClose hook to cleanly drain the realtime server
await fastify.register(fastifyRealtime(fastify, realtime));

await fastify.listen({ port: 3000 });
```

> **Production Deployment Tip:** Use Nginx, Caddy, Envoy, or AWS ALB to expose a single domain, routing `/ws` to port `4001` (uWS) and all other routes to port `3000` (Node HTTP/Express/Fastify).

---

### 11. Capacity Limits, Rate Limiting & Backpressure

Protect your application against denial-of-service, slow-loris connection holding, and heap exhaustion:

```typescript
const realtime = createRealtime({
  limits: {
    maxConnections: 50_000,            // Total concurrent connection ceiling
    maxPayloadBytes: 256 * 1024,       // 256 KiB maximum inbound frame size
    maxBackpressureBytes: 512 * 1024,  // 512 KiB outbound buffer cap per socket
    authTimeoutMs: 10_000,             // Maximum duration allowed to authenticate
  },
});
```

- **Outbound Backpressure**: If a slow client's outbound buffer exceeds `maxBackpressureBytes`, further messages are safely dropped for that client and tracked in metrics (`messagesDropped`). Fast peers are never stalled.
- **Unresponsive Client Eviction**: Persistent backpressure or throwing socket writes result in immediate connection termination and state cleanup.

---

### 12. Heartbeat & Liveness Sweeper

Rather than spawning tens of thousands of individual `setInterval` timers (which degrade the Node.js event loop), `@oneunit/realtime` utilizes a **single shared timer** that sweeps all active connections:

```typescript
// Configured in HubConfig (via Hub or createRealtime)
pingIntervalMs: 25_000, // Sweep interval (25 seconds)
pongTimeoutMs: 75_000,  // Disconnect threshold if no inbound activity (75 seconds)
```

- Every inbound frame (messages, joins, pings) updates the connection's `lastSeenAt` timestamp.
- Connections that remain silent past `pongTimeoutMs` are closed with reason `"heartbeat expiry"`.
- The timer is `unref()`'d, ensuring it never prevents Node.js from exiting cleanly during shutdown.

---

### 13. Observability, Telemetry & Health Checks

#### In-Memory Metrics Snapshot

Inspect live hub operational metrics without third-party APM overhead:

```typescript
const snapshot = realtime.hub.metricsSnapshot;
console.log({
  connections: snapshot.connections,       // Total active connections
  authenticated: snapshot.authenticated,   // Authenticated & active sockets
  authenticating: snapshot.authenticating, // Sockets in auth handshake
  rooms: snapshot.rooms,                   // Total active rooms
  documents: snapshot.documents,           // Total active documents
  memberships: snapshot.memberships,       // Total room memberships
  subscriptions: snapshot.subscriptions,   // Total document subscriptions
  published: snapshot.messagesPublished,   // Total messages published
  dropped: snapshot.messagesDropped,       // Messages dropped due to backpressure
});
```

#### Health Status Report

```typescript
const health = realtime.health();
// {
//   healthy: true,
//   readyMessage: "uWebSockets.js ready",
//   address: { host: "0.0.0.0", port: 4001, path: "/ws" },
//   connectionCount: 1420
// }
```

#### Lifecycle Events

```typescript
realtime.on("ready", () => console.log("Server listening"));
realtime.on("error", (err) => console.error("Server error:", err));
realtime.on("closed", () => console.log("Server shutdown complete"));
```

---

### 14. Graceful Teardown & Drain Sequence

Graceful termination is essential for rolling deployments (Kubernetes, ECS, Docker):

```typescript
const result = await realtime.close({ timeoutMs: 5_000 });

console.log(`Drained ${result.drainedConnections} connections in ${result.durationMs}ms`);
console.log(`Forced closed: ${result.forcedClose}`);
```

**Teardown Sequence:**
1. State transitions to `draining`: new incoming handshakes and publish actions are immediately rejected.
2. Sockets receive a close frame with code `1001` (Going Away).
3. The shared heartbeat timer is halted.
4. Room and document subscriptions are cleared through the idempotent `DisconnectCoordinator`.
5. The native `uWebSockets.js` listener is unbinded and closed.
6. If connections remain open when `timeoutMs` expires, they are terminated forcefully.

---

## Horizontal Scaling & Multi-Node Federation

`@oneunit/realtime` is intentionally designed as a single-process runtime. To scale horizontally across multiple instances or Kubernetes pods:
1. Place a load balancer (AWS ALB, Nginx, Cloudflare) in front of your realtime instances.
2. Connect your external message broker (Redis Pub/Sub, Kafka, NATS) to the hub's `BroadcastTarget` interface.

```
                  Load Balancer (Round-Robin / IP-Hash)
                  │                  │                  │
                  ▼                  ▼                  ▼
          ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
          │ Realtime Node1│  │ Realtime Node2│  │ Realtime Node3│
          └───────┬───────┘  └───────┬───────┘  └───────┬───────┘
                  │                  │                  │
                  └──────────┬───────┴──────────────────┘
                             ▼
                 External Message Broker
              (Redis Pub/Sub / NATS / Kafka)
```

### Implementing `BroadcastTarget` with Redis Pub/Sub

```typescript
import { createRealtime, type BroadcastTarget } from "@oneunit/realtime";
import { Redis } from "ioredis";

const realtime = createRealtime({ port: 4001 });
await realtime.listen();

const redisPublisher = new Redis(process.env.REDIS_URL);
const redisSubscriber = new Redis(process.env.REDIS_URL);

// 1. Inbound from external broker -> Local Hub Fan-out
await redisSubscriber.subscribe("realtime:channel:*");
redisSubscriber.on("message", (channel, messageStr) => {
  const channelName = channel.replace("realtime:channel:", "");
  const payload = JSON.parse(messageStr);
  
  // Deliver locally across this node's active connections
  void realtime.hub.broadcast(channelName, payload);
});

// 2. Outbound from Local Hub -> External Broker
export async function publishToCluster(channel: string, message: unknown) {
  await redisPublisher.publish(`realtime:channel:${channel}`, JSON.stringify(message));
}
```

---

## Error Handling & Error Code Dictionary

All errors emitted by the package inherit from `HubError` and carry a machine-readable `code` property. Internal stack traces and secret credentials are never leaked to clients.

| Error Class | Code | Cause & Recommended Action |
|---|---|---|
| `ConnectionLimitError` | `CONNECTION_LIMIT` | Global connection ceiling reached. Scale out or increase `maxConnections`. |
| `MessageTooLargeError` | `MESSAGE_TOO_LARGE` | Inbound frame exceeded `maxPayloadBytes`. Ensure frames are within bounds. |
| `RoomFullError` | `ROOM_FULL` | Room reached configured capacity limit. |
| `RateLimitedError` | `RATE_LIMITED` | Client exceeded publish rate limits. |
| `UnauthenticatedError` | `UNAUTHENTICATED` | Token missing, invalid, or expired during handshake. |
| `ForbiddenError` | `FORBIDDEN` | Authorization hook rejected action (e.g. unauthorized room join). |
| `ValidationFailedError` | `VALIDATION_FAILED` | Inbound payload violated protocol framing or envelope rules. |
| `AuthenticationTimeoutError` | `AUTHENTICATION_TIMEOUT` | Auth hook did not resolve within `authTimeoutMs`. Check auth backend latency. |
| `ConnectionNotAuthenticatedError` | `CONNECTION_NOT_AUTHENTICATED` | Client attempted action prior to completion of authentication. |
| `TenantIsolationError` | `TENANT_ISOLATION` | Attempted cross-tenant data access. |
| `CleanupError` | `CLEANUP_ERROR` | An error occurred during connection disconnect cleanup. |
| `UwsListenFailedError` | `UWS_LISTEN_FAILED` | Failed to bind uWS native listener to port (port in use or permissions). |
| `HandshakeUnauthorizedError` | `HANDSHAKE_UNAUTHORIZED` | Upgrade rejected during pre-handshake authentication. |
| `HandshakeOriginRejectedError` | `HANDSHAKE_ORIGIN_REJECTED` | Request origin not included in `allowedOrigins`. |

---

## Runnable Examples

The repository includes ready-to-run examples in the `examples/` directory:

| Example File | Execution Command | Description |
|---|---|---|
| `chat.ts` | `npx tsx examples/chat.ts` | Standalone uWS chat server with token authentication |
| `client.ts` | `npx tsx examples/client.ts` | Terminal chat client connecting via `@oneunit/realtime/client` |
| `e2ee.ts` | `npx tsx examples/e2ee.ts` | Libsodium E2EE cryptographic envelope routing demo |
| `e2ee-client.ts` | `npx tsx examples/e2ee-client.ts` | End-to-end encrypted client workflow |
| `adapter.ts` | `npx tsx examples/adapter.ts` | Low-level transport adapter integration |
| `standalone.ts` | `npx tsx examples/standalone.ts` | Minimal standalone realtime server instance |

---

## Technical Architecture

For an exhaustive technical breakdown of the internals, concurrency model, memory layout, cryptographic proofs, and subsystem logic, see the dedicated [ARCHITECTURE.md](./ARCHITECTURE.md) guide:

- **Subsystem Deep Dives**: Complete breakdowns of `core`, `transport`, `presence`, `room-namespace`, `collab`, `e2ee`, `event`, and `protocol`.
- **State Machine Diagrams**: Detailed 5-state lifecycle analysis and cleanup pipelines.
- **Memory & Concurrency Model**: Event-loop interleaving, array buffer copying, and atomic index mutations.
- **Cryptographic Security Proofs**: Zero-knowledge trust boundaries, replay guards, and AEAD sealing flows.

---

## Verification & Development

To contribute or verify the package locally:

```bash
# Full verification pipeline (clean, build, typecheck, lint, test, pack verification)
npm run verify

# Step-by-step scripts
npm run clean       # Remove build artifacts and tsbuildinfo
npm run build       # Compile TypeScript to dist/
npm run typecheck   # Typecheck src/, test/, and examples/
npm run lint        # Run ESLint across codebase
npm test            # Run Vitest test suite (201 unit & integration tests)
npm run pack:check  # Dry-run npm pack to audit packaged files
```

---

## License

[MIT](./LICENSE) © 2026 mayank
