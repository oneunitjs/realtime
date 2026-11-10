# Architecture Consolidation & uWebSockets.js-Only Transport Migration Plan

**Project:** `@oneunit/realtime`  
**Plan version:** 2.0  
**Review date:** 2026-11-07  
**Status:** Proposed target architecture and implementation blueprint  
**Scope:** Consolidate the existing real-time architecture, remove verified duplication/dead code, standardize lifecycle and contracts, and make uWebSockets.js the only WebSocket engine while integrating with common Node.js HTTP frameworks.

---

## 1. Executive decision

The package will use **uWebSockets.js as its only WebSocket server and framing engine**.

It will continue to integrate with applications that use:

- Node.js `http` and `https`
- Express
- Fastify
- Koa
- Other frameworks that expose a Node HTTP server, lifecycle hooks, or a documented custom integration point
- A reverse proxy or ingress such as Nginx, Caddy, Traefik, Envoy, or a cloud load balancer

However, there is a critical architectural distinction:

> **A framework integration is not the same thing as sharing the framework's TCP listener.**

uWebSockets.js owns its own native HTTP/WebSocket server implementation. It is not a WebSocket handler that can simply be attached to an arbitrary Node `http.Server` `upgrade` event. The official project describes it as a native V8 addon and web server; its public API exposes its own `App` / `SSLApp`, route registration, WebSocket upgrade, and listen lifecycle. Its WebSocket route API is not the Node `http.Server` upgrade API. See the official [uWebSockets.js repository](https://github.com/uNetworking/uWebSockets.js) and [WebSocketBehavior API](https://unetworking.github.io/uWebSockets.js/generated/interfaces/WebSocketBehavior.html).

Therefore the package must offer two honest integration modes:

1. **Native uWS host mode:** uWS owns the listener. The application can register supported HTTP routes on the same uWS app, or use a documented framework-compatible HTTP bridge where one is deliberately provided. This is the highest-performance, single-listener mode.
2. **Framework-hosted mode:** Express/Fastify/Koa/Node HTTP continues to own the application's HTTP listener. The package starts a dedicated uWS listener for WebSockets. A reverse proxy or ingress routes the WebSocket path to that listener. The package provides framework plugins, lifecycle hooks, health/status integration, URL discovery, and proxy examples.

The package must **not** claim that Express, Fastify, Koa, and an arbitrary Node HTTP server can all share one TCP port with a native uWS WebSocket route without a proxy or a different server topology. If same-port routing is mandatory, the supported solution is to make uWS the front-door server and route HTTP to the application, or use a proxy in front of both. No fallback to `ws`, `WebSocketServer`, or another WebSocket engine is permitted.

### Primary architecture choice

- One public Hub runtime: `createRealtimeHub()` / `RealtimeHub`.
- One transport engine: uWebSockets.js.
- One normalized internal connection contract.
- One transport lifecycle owner.
- One connection registry.
- One room/namespace membership authority.
- One presence authority.
- One event delivery authority.
- One authoritative architecture document per subsystem.
- Framework adapters are integration glue only; they do not implement WebSocket protocol handling.

---

## 2. Why this change is needed

### 2.1 Current architecture problems observed in the supplied archives

The previous static review of `docs.zip` and `src.zip` found the following structural risks:

1. Two competing Hub implementations:
   - `src/core/hub.ts`
   - `src/core/core-hub.ts`
2. Multiple transport contracts:
   - `Connection` in `src/types.ts`
   - `TransportConnection` in `src/core/connection/connection.types.ts`
   - Presence and Rooms/Namespaces transport-specific contracts
3. Multiple transport implementation locations:
   - `src/transport/`
   - `src/presence/transport/`
   - `src/room-namespace/transport/`
4. Both `ws` and uWebSockets implementations exist in the main transport layer.
5. Legacy transport code imports multiple WebSocket libraries directly.
6. The transport factory probes for uWS but was observed returning the `ws` implementation regardless; behavior and intent disagree.
7. `src/server/realtime.ts` starts adapter initialization and listening independently, creating a startup-order risk.
8. Server readiness is detected by polling adapter port state rather than awaiting a readiness promise.
9. The adapter path accessor returns a hard-coded value rather than the configured path.
10. Some room/socket methods update local state before asynchronous Hub operations are known to have succeeded.
11. Some asynchronous broadcast/send errors are swallowed or not awaited.
12. Architecture documents disagree about which Hub runtime is canonical.
13. Rooms/Namespaces architecture documents include an exact duplicate; transport architecture documents are near-duplicates.

These are findings from static inspection of the supplied source archive, not claims that every risk has been reproduced at runtime. Package metadata, tests, CI, and runtime traces were not present in the supplied archives. Confirm each issue against the complete repository before destructive changes.

### 2.2 Why one WebSocket engine

Maintaining both `ws` and uWebSockets.js creates:

- Two sets of library-specific lifecycle behavior.
- Two implementations of frame conversion and close semantics.
- Two backpressure models.
- Two sets of package/version compatibility concerns.
- More branches in the Hub and transport factory.
- More integration tests and more failure combinations.
- A risk that production and test environments exercise different implementations.
- Unclear support guarantees when a bug exists in only one adapter.

A single uWS engine reduces the number of code paths and makes the transport contract testable against one concrete implementation.

### 2.3 Why framework integration still matters

Applications should not have to abandon their existing HTTP framework to use the package. Their HTTP framework may already own:

- REST routes
- Authentication middleware
- Cookies and sessions
- Request logging
- Rate limits
- OpenAPI routes
- Health checks
- Dependency injection
- Application startup and shutdown

The real-time package should integrate into that lifecycle without pretending that the framework's HTTP server and uWS are the same server.

The integration layer should therefore:
- Accept an existing Node HTTP server or framework instance.
- Coordinate startup and shutdown.
- Provide a separate uWS listener when the host server is a Node HTTP server.
- Expose the actual WebSocket URL/port.
- Provide proxy configuration guidance for same-origin browser URLs.
- Allow the host framework to continue serving HTTP routes.
- Keep authentication and authorization consistent across both entry points.

### 2.4 Why not silently fall back to `ws`

A fallback would undermine the architectural goal. It would make the runtime depend on which package happens to be installed or which branch happens to execute. It would also make production behavior harder to reproduce.

If uWebSockets.js cannot be loaded or initialized:
- Startup must fail clearly.
- The error must identify the missing native dependency or unsupported runtime.
- The package must not quietly switch WebSocket engines.
- The application may choose to fail startup or explicitly disable real-time functionality, but that is an application-level decision.

---

## 3. Transport topology: what is and is not possible

### 3.1 Supported topology A — Native uWS owns the listener

```text
                 Browser / Client
                        |
                   HTTPS / WSS
                        |
                uWebSockets.js App
                  /             \
          HTTP routes         WS route
              |                  |
       App HTTP handlers     Transport Adapter
                                 |
                           Canonical Hub
                                 |
                 Rooms / Presence / Events / Docs
```

Use this when:
- The application can use uWS as its front-door HTTP server.
- Maximum performance and minimum network hops are priorities.
- The application can register its HTTP endpoints in uWS or expose other services behind a proxy.
- The deployment team is comfortable operating uWS as the server listener.

Benefits:
- One listener and one TLS endpoint.
- No extra proxy hop between the application and WebSocket server.
- Native uWS routing, WebSocket framing, and backpressure.
- Straightforward ownership of the WebSocket path.

Trade-off:
- Existing Express/Fastify/Koa middleware does not automatically run inside uWS. Framework request handlers are not magically portable to uWS request/response objects.

### 3.2 Supported topology B — Existing Node framework plus dedicated uWS listener

```text
                      Browser
                         |
                 https://app.example
                         |
                 Reverse Proxy / Ingress
                    /             \
       /api, /auth, /health       /realtime
                |                    |
       Existing Node server      uWS listener
       Express / Fastify / Koa   uWebSockets.js
                |                    |
       Existing middleware       uWS handshake
       and HTTP routes                |
                                  Hub runtime
                                      |
                         Rooms / Presence / Events
```

The application framework keeps its current HTTP listener. The real-time package starts a separate uWS listener, for example on an internal port. A reverse proxy routes the public WebSocket path to that listener.

Example:
- Framework HTTP listener: `127.0.0.1:3000`
- Internal uWS listener: `127.0.0.1:4001`
- Public HTTP URL: `https://app.example.com`
- Public WebSocket URL: `wss://app.example.com/realtime`

The reverse proxy sends ordinary requests to port 3000 and WebSocket upgrade requests on `/realtime` to port 4001.

Benefits:
- Existing framework and middleware remain in place.
- uWS remains the only WebSocket engine.
- Framework integration is possible without rewriting HTTP endpoints.
- The real-time package owns its own WebSocket lifecycle and can expose readiness separately.

Trade-offs:
- There are two local listeners.
- A reverse proxy or ingress must route the WebSocket path.
- The browser sees one public origin only if proxy routing is configured correctly.
- Authentication context must be safely passed or independently validated at the uWS handshake.

### 3.3 Supported topology C — uWS front door with framework HTTP service behind it

```text
                Browser / Client
                       |
                Reverse Proxy / LB
                       |
                 uWS front door
                  /           \
          WebSocket path     HTTP proxy/bridge
                |                  |
             Hub             Existing framework
                              Express/Fastify/Koa
```

This is useful where one public port is mandatory but the application needs to preserve an existing framework for HTTP routes. uWS owns the public listener; normal HTTP paths are forwarded to the framework service or a separately managed HTTP backend.

This is a deployment topology, not a promise that framework middleware executes natively inside uWS.

### 3.4 Not supported: direct attachment to an arbitrary Node HTTP listener

The package must not expose an API that implies the following works natively:

```ts
// Do not promise this as a general capability:
realtime.attach(existingNodeHttpServer); // "uWS handles this server's upgrade event"
```

A Node `http.Server` and a uWS `App` have distinct server and socket ownership models. uWS exposes its own `App().ws(...)` and `App().listen(...)` APIs. It does not provide a general drop-in implementation of the Node HTTP `upgrade` event handler.

The package may accept an existing server in framework-hosted mode to coordinate lifecycle and discover the application context, but it must start a distinct uWS listener unless the host is itself a uWS app.

### 3.5 Integration support matrix

| Host / environment | Integration mode | Same public port without proxy? | Support |
|---|---|---:|---|
| Node `http.Server` | Dedicated uWS listener + reverse proxy | No | First-class |
| Node `https.Server` | Dedicated uWS TLS listener or internal plain listener behind trusted TLS proxy | No | First-class |
| Express | Express plugin + dedicated uWS listener | No | First-class |
| Fastify | Fastify plugin + dedicated uWS listener | No | First-class |
| Koa | Koa helper/plugin + dedicated uWS listener | No | First-class |
| Custom Node framework exposing `http.Server` | Generic host adapter + dedicated uWS listener | No | Supported generic mode |
| Native uWS `App` | Mount route on supplied uWS app | Yes | First-class |
| Reverse proxy / ingress | Route `/realtime` to uWS | Yes from client perspective | First-class deployment pattern |
| Arbitrary non-Node server | Separate uWS endpoint or proxy integration | Depends on deployment | Documented custom mode |
| Bun / other runtimes | Only if the selected uWS package/runtime combination is officially supported and tested | Depends | Explicit compatibility matrix; do not assume |

The word “all” must mean “all hosts that can use the documented dedicated-listener/proxy integration,” not “every server can share the exact same TCP listener.” Unknown frameworks can use the generic integration contract.

---

## 4. Target architecture

### 4.1 High-level design

```text
                    Application Developer
                             |
                 Public Realtime API / SDK
                             |
                  Framework Integration Layer
              (Express / Fastify / Koa / Node HTTP)
                             |
              Host Lifecycle + URL/Proxy Metadata
                             |
             +---------------+----------------+
             |                                |
      Native uWS mode                 Framework-hosted mode
      caller supplies uWS App         package owns uWS App
             |                                |
             +---------------+----------------+
                             |
                  uWS Transport Host
                             |
                  uWS WebSocket Route
                             |
                 Normalized Connection
                             |
                    Canonical Hub
                             |
       +----------+----------+----------+----------+
       |          |          |          |          |
     AuthZ      Rooms     Presence    Events   Collaboration
       |          |          |          |          |
       +----------+----------+----------+----------+
                             |
                       E2EE Policy
```

### 4.2 Layer responsibilities

#### Public API / facade
- Provides intuitive `createRealtime()` / `Realtime.create()` entry points.
- Owns user-facing configuration validation.
- Hides internal module composition.
- Exposes typed lifecycle and feature APIs.
- Provides migration-compatible wrappers for older APIs.

#### Framework integration
- Detects or accepts the host server explicitly.
- Registers framework startup/shutdown hooks.
- Creates or receives the uWS app.
- Exposes the effective WebSocket URL.
- Does not implement WebSocket protocol framing.
- Does not own room, presence, or event logic.
- Does not patch undocumented framework internals.

#### uWS transport host
- Owns the uWS `App` / `SSLApp` lifecycle when it creates the app.
- Registers the configured WebSocket route.
- Applies uWS `WebSocketBehavior` limits and callbacks.
- Owns handshake, message, ping/pong, drain, dropped, and close callbacks.
- Normalizes uWS events into the internal transport contract.
- Handles native uWS send status and backpressure semantics.

#### Canonical Hub
- Owns application connection identity and state.
- Authenticates the principal.
- Orchestrates middleware and authorization.
- Routes messages to the appropriate domain service.
- Owns disconnect orchestration and cleanup.
- Does not import uWS types or concrete library APIs.

#### Domain services
- Rooms/Namespaces own membership and room policy.
- Presence owns leases, online aggregation, and awareness.
- Events own recipient snapshots, delivery tracking, ACKs, retries, and expiry.
- Collaboration owns CRDT and document synchronization.
- E2EE owns envelope and key-epoch policy.
- Error handling owns stable public error codes.

### 4.3 Dependency direction

Allowed:

```text
Public API -> Framework Integration -> Transport Host -> Hub -> Domain Services
```

Forbidden:
- Hub importing `uWebSockets.js`.
- Presence importing uWS socket types.
- Rooms importing uWS route types.
- Event service sending directly through a concrete uWS socket.
- Framework adapters implementing their own socket registry.
- A domain service creating a WebSocket server.
- Public API exporting native uWS objects as its normal connection contract.

Only the transport package should import `uWebSockets.js`.

---

## 5. Core transport design

### 5.1 Canonical normalized contract

Use one internal connection contract. The Hub must not know whether the connection came from a uWS app supplied by the user or a uWS app created by the package.

```ts
export interface TransportConnection {
  readonly id: string;
  readonly remoteAddress?: string;
  readonly state: "open" | "closing" | "closed";

  /**
   * Resolves when the frame has been accepted by the local uWS send path.
   * It is NOT proof that the peer received or processed the message.
   */
  send(
    data: Uint8Array,
    options?: SendOptions
  ): Promise<SendResult>;

  close(
    code?: number,
    reason?: string
  ): Promise<void>;

  bufferedBytes(): number;

  onMessage(
    handler: (message: TransportMessage) => void
  ): Unsubscribe;

  onClose(
    handler: (event: TransportCloseEvent) => void
  ): Unsubscribe;

  onDrain(
    handler: () => void
  ): Unsubscribe;
}

export interface TransportMessage {
  readonly data: Uint8Array;
  readonly isBinary: boolean;
}

export interface SendOptions {
  readonly compress?: boolean;
}

export type SendResult =
  | { status: "accepted"; bufferedBytes: number }
  | { status: "backpressured"; bufferedBytes: number };

export interface TransportCloseEvent {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

export type Unsubscribe = () => void;
```

Important:
- `send()` is local acceptance, not delivery acknowledgment.
- `backpressured` must not be confused with successful delivery.
- A hard failure must be represented as a typed error/rejection.
- A message payload must be copied or consumed synchronously while its native memory is valid.
- The contract must not expose a uWS `WebSocket<UserData>` to the Hub.
- If the public API needs a simpler `socket.send()`, the public facade can wrap the internal result with a documented policy.

### 5.2 uWS memory lifetime rule

The uWS WebSocket `message` callback receives an `ArrayBuffer`. The official API documents that this memory is valid during the callback lifetime and can be neutered after the callback returns or reaches an `await`. The adapter must therefore copy the bytes before:
- awaiting authentication or middleware;
- scheduling asynchronous work;
- placing the data on a queue;
- returning control to the uWS callback.

Never retain a borrowed native message buffer across an `await`.

The same rule applies to dropped-message callback data. See the official [WebSocketBehavior documentation](https://unetworking.github.io/uWebSockets.js/generated/interfaces/WebSocketBehavior.html).

### 5.3 Native uWS send result handling

The adapter must map the concrete uWS send return values into the normalized contract. It must not assume a Boolean return or a Node-style callback.

Implementation requirements:
1. Read the exact return semantics for the pinned uWS version.
2. Map accepted, backpressured, and dropped outcomes to `SendResult`.
3. Use `getBufferedAmount()` to report buffered bytes.
4. Use the `drain` callback to resume upstream queues.
5. Treat `dropped` as a real delivery-path event, not a debug-only callback.
6. Do not enqueue unbounded application messages while a socket is backpressured.
7. Never mark an event delivered because the uWS send method accepted a local write.

The uWS API exposes `maxBackpressure`, `closeOnBackpressureLimit`, `drain`, `dropped`, and `getBufferedAmount()` behavior. The precise mapping must be tested against the pinned release. See [WebSocketBehavior](https://unetworking.github.io/uWebSockets.js/generated/interfaces/WebSocketBehavior.html).

### 5.4 Backpressure policy

Use three levels:

| Level | Condition | Required behavior |
|---|---|---|
| Normal | Below soft threshold | Send normally |
| Soft pressure | Above soft threshold | Pause or reduce upstream enqueueing; coalesce replaceable state updates |
| Hard pressure | Above hard threshold or native send policy indicates terminal overflow | Stop queueing; close or disconnect according to documented policy; emit typed reason |

Rules:
- Configure one canonical hard limit and align it with uWS `maxBackpressure`.
- Do not create an unbounded secondary queue in TypeScript.
- Use `drain` to resume pending work.
- `dropped` must update metrics and delivery state.
- Presence/cursor updates may be coalesced or dropped according to explicit ephemeral semantics.
- Durable events must be retried or marked failed by Event Delivery, not silently dropped.
- CRDT updates require an explicit resync/recovery strategy if delivery is lost.
- A hard-close policy must be consistent across all clients and tests.

### 5.5 Message limits and frame handling

Define a single configured maximum inbound payload size and apply it in uWS `maxPayloadLength`. The same logical limit must be checked by the Hub before decoding.

- Reject oversized input before JSON/CBOR/MessagePack parsing.
- Distinguish text and binary frames.
- Prefer binary frames for the internal application protocol.
- If text is supported, decode as UTF-8 using a documented policy.
- Validate UTF-8 where text semantics require it.
- Do not use string coercion on arbitrary binary payloads.
- Do not parse data before authentication/connection-state checks where the protocol permits early rejection.

### 5.6 Ping, pong, and heartbeat

Use uWS-native ping/pong and idle timeout where appropriate. The Hub's presence lease is an application-level concept and should not be confused with the transport idle timeout.

Define separately:
- Transport idle timeout: whether the socket is still alive.
- Application heartbeat: whether the client protocol session is healthy.
- Presence lease: whether a user/device is considered online.

Do not run multiple independent timers that all close the same connection. One layer should decide transport liveness; the Hub receives a normalized liveness/close event; Presence updates its lease from Hub lifecycle.

---

## 6. Framework integration architecture

### 6.1 Integration design principles

1. Framework packages are optional integration helpers, not transport engines.
2. The core package must not depend on Express, Fastify, or Koa.
3. The core package must not inspect undocumented framework internals.
4. Framework plugins must be thin and lifecycle-focused.
5. Every integration must clearly state whether it starts a separate uWS listener.
6. The actual public `wsUrl` must be discoverable after startup.
7. Reverse proxy headers are trusted only when the deployment explicitly configures trusted proxies.
8. Framework middleware does not automatically run on uWS handshake requests in separate-listener mode.
9. Authentication must be shared through a deliberate token/session validation mechanism, not by assuming framework request objects are available in uWS.

### 6.2 Generic host interface

Define a minimal generic interface:

```ts
export interface HostServerAdapter {
  readonly kind: string;

  /**
   * Optional existing Node HTTP server.
   * Used for lifecycle integration and host metadata only.
   * It is NOT passed to uWS as a native listener.
   */
  readonly httpServer?: import("node:http").Server;

  onStart?(callback: () => Promise<void>): Unsubscribe;
  onClose?(callback: () => Promise<void>): Unsubscribe;

  /**
   * Return public origin/URL only when the host knows it.
   * Otherwise configure publicUrl explicitly.
   */
  getPublicOrigin?(): string | undefined;
}
```

This interface deliberately avoids:
- framework request/response types;
- direct `upgrade` event ownership;
- undocumented access to framework internals;
- assumptions that the host can accept a uWS route.

A generic Node HTTP integration can receive an existing `http.Server` and use its `listening` / `close` lifecycle, but the package starts a distinct uWS listener.

### 6.3 Core API: create and start

Recommended public API:

```ts
import { createRealtime } from "@oneunit/realtime";

const realtime = createRealtime({
  transport: {
    engine: "uwebsockets",
    mode: "dedicated",
    path: "/realtime",
    listen: {
      host: "127.0.0.1",
      port: 4001,
    },
    publicUrl: "wss://app.example.com/realtime",
    maxPayloadLength: 64 * 1024,
    maxBackpressure: 256 * 1024,
  },
});

await realtime.start();

console.log(realtime.address);
console.log(realtime.wsUrl);
```

API design requirements:
- `engine` is explicit and only accepts `"uwebsockets"`; it is not a switch between multiple engines.
- `mode` is explicit: `"dedicated"` or `"native"`.
- `path` is normalized once and reported accurately.
- `listen` is the internal bind address, not necessarily the public address.
- `publicUrl` is the externally reachable URL when proxying is used.
- `start()` resolves only when the uWS listener is ready.
- `close()` resolves only when owned resources have been shut down.
- No fire-and-forget initialization from the constructor.
- No polling for port readiness.
- No silent transport fallback.

### 6.4 Native uWS app integration

```ts
import { App } from "uWebSockets.js";
import { createRealtime } from "@oneunit/realtime";

const app = App();

const realtime = createRealtime({
  transport: {
    engine: "uwebsockets",
    mode: "native",
    app,
    path: "/realtime",
  },
});

app.get("/health", (res) => {
  res.end("ok");
});

await realtime.start({
  listen: {
    host: "0.0.0.0",
    port: 3000,
  },
});
```

The implementation must define whether `start()` owns the supplied app's listen call. Recommended:
- If the package creates the uWS app, it owns listen/close.
- If the caller supplies an app, the caller can either delegate listen ownership to the package or call an explicit `mount()` and retain ownership.
- Do not allow ambiguous ownership. Model it with explicit options or distinct methods.

A clearer API may be:

```ts
const realtime = createRealtime({ transport: { mode: "native", app } });

realtime.mount(); // registers routes only; does not listen
app.listen(3000, onListen);
```

or:

```ts
await realtime.listen({ host: "0.0.0.0", port: 3000 });
```

Choose one public pattern and do not support multiple ambiguous ownership paths.

### 6.5 Express integration

```ts
import express from "express";
import { createServer } from "node:http";
import { createRealtime } from "@oneunit/realtime";
import { expressRealtime } from "@oneunit/realtime/express";

const app = express();
const httpServer = createServer(app);

const realtime = createRealtime({
  transport: {
    engine: "uwebsockets",
    mode: "dedicated",
    path: "/realtime",
    listen: { host: "127.0.0.1", port: 4001 },
    publicUrl: "wss://app.example.com/realtime",
  },
});

app.use(express.json());
app.get("/health", (_req, res) => res.json({ ok: true }));

app.use(expressRealtime(realtime, { httpServer }));

httpServer.listen(3000);

await realtime.start();
```

The Express integration helper:
- stores the realtime instance in application locals if useful;
- registers graceful shutdown hooks only when configured to do so;
- exposes health/readiness status;
- optionally exposes a route that returns the public WebSocket URL;
- does not intercept Node's `upgrade` event and pass the socket to uWS;
- does not install a `ws` server.

The package must document that the public proxy routes `/realtime` to the dedicated uWS port.

### 6.6 Fastify integration

```ts
import Fastify from "fastify";
import { createRealtime } from "@oneunit/realtime";
import { fastifyRealtime } from "@oneunit/realtime/fastify";

const fastify = Fastify({ logger: true });

const realtime = createRealtime({
  transport: {
    engine: "uwebsockets",
    mode: "dedicated",
    path: "/realtime",
    listen: { host: "127.0.0.1", port: 4001 },
    publicUrl: "wss://app.example.com/realtime",
  },
});

await fastify.register(fastifyRealtime, { realtime });

fastify.get("/health", async () => ({ ok: true }));

await fastify.listen({ host: "0.0.0.0", port: 3000 });
await realtime.start();
```

Implementation requirements:
- Use Fastify's documented plugin lifecycle.
- Register shutdown with `onClose` or an equivalent documented hook.
- Avoid relying on undocumented internal server fields.
- If the Fastify instance exposes the underlying Node server through a documented API, use it only for lifecycle/metadata.
- Do not claim the Fastify server itself is hosting the uWS WebSocket route.

### 6.7 Koa integration

```ts
import Koa from "koa";
import { createServer } from "node:http";
import { createRealtime } from "@oneunit/realtime";
import { koaRealtime } from "@oneunit/realtime/koa";

const app = new Koa();
const httpServer = createServer(app.callback());

const realtime = createRealtime({
  transport: {
    engine: "uwebsockets",
    mode: "dedicated",
    path: "/realtime",
    listen: { host: "127.0.0.1", port: 4001 },
    publicUrl: "wss://app.example.com/realtime",
  },
});

koaRealtime(app, realtime, { httpServer });

httpServer.listen(3000);
await realtime.start();
```

Koa integration should remain a small helper. It should not wrap or emulate the Koa request/response pipeline for WebSocket traffic.

### 6.8 Plain Node HTTP / HTTPS

```ts
import { createServer } from "node:http";
import { createRealtime } from "@oneunit/realtime";
import { nodeHttpRealtime } from "@oneunit/realtime/node-http";

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200).end("ok");
    return;
  }

  res.writeHead(404).end();
});

const realtime = createRealtime({
  transport: {
    engine: "uwebsockets",
    mode: "dedicated",
    path: "/realtime",
    listen: { host: "127.0.0.1", port: 4001 },
    publicUrl: "wss://example.com/realtime",
  },
});

nodeHttpRealtime(server, realtime);

server.listen(3000);
await realtime.start();
```

The helper coordinates lifecycle only. It does not attach uWS to the Node server's `upgrade` event.

### 6.9 Custom server integration

For a custom framework:
- implement `HostServerAdapter`;
- provide a lifecycle callback or call `realtime.start()` / `realtime.close()` manually;
- configure a dedicated uWS listener;
- configure a proxy route if one public origin is required.

This generic mode is the extensibility guarantee. Do not create a custom transport engine for every framework.

---

## 7. Authentication and framework middleware

### 7.1 The middleware boundary

In dedicated-listener mode, the WebSocket handshake is handled by uWS, not Express/Fastify/Koa. Therefore host-framework middleware does not automatically execute for that handshake.

The package must provide a framework-independent handshake context:

```ts
export interface HandshakeContext {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly origin?: string;
  readonly remoteAddress?: string;
  readonly query: Readonly<Record<string, string>>;
  readonly protocol?: string;
  readonly signal: AbortSignal;
}

export interface AuthenticateHandshake {
  (context: HandshakeContext): Promise<AuthenticatedPrincipal>;
}
```

Recommended authentication mechanisms:
1. Secure, short-lived access token in an agreed handshake mechanism.
2. Signed session cookie, validated by the same session service as the HTTP app.
3. One-time connection ticket minted by an authenticated HTTP endpoint.

Prefer a short-lived, one-time ticket when cookies or bearer credentials cannot be safely shared with the dedicated listener.

Do not:
- trust user ID or tenant ID supplied in query parameters;
- trust arbitrary forwarded headers;
- trust `Origin` as authentication;
- assume Express middleware has populated a request object;
- place long-lived bearer secrets in URLs that are logged by proxies.

### 7.2 One shared auth policy

The framework and WebSocket path should call the same application authentication service, but through transport-appropriate input adapters.

```text
HTTP request -> Framework middleware -> Auth service -> Principal
                                         ^
                                         |
uWS handshake -> Handshake adapter -----+
```

The output is the same trusted `Principal` model. The input objects differ.

### 7.3 Origin and proxy security

- Validate `Origin` against an explicit allowlist for browser clients.
- Define behavior for native clients with no Origin.
- Trust `X-Forwarded-For`, `Forwarded`, and forwarded protocol only from configured proxy IPs or trusted proxy infrastructure.
- Do not derive public WebSocket URLs from untrusted headers.
- Configure TLS either at uWS or at a trusted edge proxy.
- When uWS listens on an internal plain-text interface behind TLS termination, bind it to loopback/private network and restrict access.

---

## 8. Lifecycle and resource ownership

### 8.1 Lifecycle state machine

```text
CREATED
   |
   v
STARTING
   | success
   v
READY
   |
   | close requested
   v
DRAINING
   |
   v
CLOSING_CONNECTIONS
   |
   v
STOPPING_UWS
   |
   v
CLOSED

STARTING -- failure --> FAILED
READY -- fatal failure --> FAILED
```

Rules:
- `start()` is idempotent and returns the same in-flight promise.
- `close()` is idempotent and returns the same in-flight promise.
- `start()` after `CLOSED` is rejected unless restart is explicitly supported.
- `close()` during `STARTING` cancels startup or waits for startup to settle and then closes resources.
- A failed start closes any partially created listener/context.
- The package does not claim `READY` before the uWS listen callback confirms success.
- No polling or arbitrary sleeps for readiness.

### 8.2 Shutdown order

1. Mark the realtime instance as draining.
2. Reject new WebSocket upgrades with a typed unavailable response.
3. Stop accepting new application-level work.
4. Notify connected clients if the protocol supports server shutdown notice.
5. Flush or fail pending durable delivery according to policy.
6. Close active connections with a documented code/reason.
7. Wait for Hub connection cleanup to finish within a bounded deadline.
8. Stop the uWS listener and release native listen token.
9. Remove callbacks and references.
10. Mark the instance closed.

If the deadline expires:
- force-close remaining connections;
- record the number and identities needed for diagnostics without logging secrets;
- return a structured shutdown result or aggregate error.

### 8.3 Ownership matrix

| Resource | Owner |
|---|---|
| uWS app created by package | Transport host |
| uWS app supplied by caller | Caller, unless ownership is explicitly transferred |
| uWS listen socket/token | Whoever called listen |
| WebSocket route registration | Realtime transport host |
| Physical socket close | uWS transport adapter |
| Connection identity/state | Hub |
| Room membership | Room service |
| Presence leases | Presence service |
| Event delivery records | Event service |
| Timers/workers | Service that creates them |
| Framework HTTP server | Application/framework |

Never let both Hub and framework plugin close the same HTTP server by default. Never let both Hub and adapter independently own the same physical WebSocket close operation.

---

## 9. Public developer experience (DX) and API design

### 9.1 Design goals

The package should feel simple for the common case and explicit for advanced deployments.

- One obvious import for the main API.
- One obvious method to start and stop.
- Strong TypeScript inference.
- No mandatory framework dependencies.
- Optional framework entry points.
- Clear separation of internal bind address and public URL.
- No hidden network listeners.
- No implicit fallback.
- No magic port polling.
- Stable error codes and helpful startup errors.
- Easy local development and production proxy configuration.
- A single documented default path.
- A clean migration path from current APIs.

### 9.2 Recommended public API shape

```ts
import { createRealtime } from "@oneunit/realtime";

const realtime = createRealtime({
  transport: {
    mode: "dedicated",
    path: "/realtime",
    listen: { host: "127.0.0.1", port: 4001 },
    publicUrl: process.env.REALTIME_PUBLIC_URL,
  },

  auth: {
    authenticate: async (context) => {
      return authService.authenticateHandshake(context);
    },
  },

  limits: {
    maxPayloadBytes: 64 * 1024,
    maxBackpressureBytes: 256 * 1024,
  },
});

await realtime.start();

console.log(realtime.wsUrl);

await realtime.close();
```

The engine is uWS by design; developers should not need to choose between `"ws"` and `"uws"`. If an engine field is kept for explicitness, it accepts only `"uwebsockets"` and rejects all other values.

### 9.3 Distinguish bind address from public URL

```ts
interface TransportListenOptions {
  host: string; // internal bind interface
  port: number; // internal port; 0 means OS-assigned port
}

interface TransportPublicOptions {
  publicUrl?: string; // externally reachable wss:// URL
  path: string;
}
```

Expose:

```ts
interface RealtimeAddress {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly publicUrl?: string;
}
```

Why:
- In proxy deployments, the internal port is not the browser port.
- Port `0` may result in a dynamically assigned port.
- The package must not incorrectly report `localhost` or an internal address as a public URL.
- `wsUrl` should be returned only when determinable; otherwise require `publicUrl` or provide a URL builder.

### 9.4 Lifecycle API

Recommended:

```ts
interface RealtimeServer {
  readonly state: "created" | "starting" | "ready" | "draining" | "closed" | "failed";
  readonly address: RealtimeAddress | null;
  readonly wsUrl: string | null;

  start(): Promise<RealtimeAddress>;
  close(options?: { timeoutMs?: number }): Promise<ShutdownResult>;

  on(event: "ready", listener: (address: RealtimeAddress) => void): Unsubscribe;
  on(event: "error", listener: (error: RealtimeError) => void): Unsubscribe;
  on(event: "closed", listener: (result: ShutdownResult) => void): Unsubscribe;
}
```

Do not start listening in the constructor. Avoid constructors that kick off background promises.

### 9.5 Type-safe room and event API

The public API should avoid stringly typed room names where an application can supply an event/room schema.

Example:

```ts
type AppEvents = {
  "chat:message": {
    room: string;
    payload: { text: string };
  };
  "document:update": {
    documentId: string;
    payload: Uint8Array;
  };
};

const realtime = createRealtime<AppEvents>(config);

await realtime.rooms.join(connectionId, {
  namespace: "chat",
  room: "team:alpha",
});

await realtime.events.publish("chat:message", {
  room: "team:alpha",
  payload: { text: "Hello" },
});
```

The exact API should follow the existing public API compatibility inventory. Do not add a new typed API while leaving two older public APIs with the same responsibility.

### 9.6 Framework plugin API

Keep optional framework integrations in explicit subpath exports:

```ts
import { expressRealtime } from "@oneunit/realtime/express";
import { fastifyRealtime } from "@oneunit/realtime/fastify";
import { koaRealtime } from "@oneunit/realtime/koa";
import { nodeHttpRealtime } from "@oneunit/realtime/node-http";
```

Requirements:
- Importing the core package must not load Express/Fastify/Koa.
- Framework packages should be peer/optional dependencies or type-only integration dependencies where feasible.
- Plugin registration should not create an extra uWS listener until the application starts.
- Plugins should support manual lifecycle mode for unusual hosts.
- Plugins must not silently take ownership of the framework HTTP server.
- A generic adapter should remain available for custom frameworks.

### 9.7 Better errors

Use stable error classes/codes:

| Code | Meaning |
|---|---|
| `UWS_MODULE_NOT_FOUND` | uWebSockets.js native module could not be loaded |
| `UWS_UNSUPPORTED_RUNTIME` | Current runtime/platform is not supported by the pinned build |
| `UWS_LISTEN_FAILED` | uWS could not bind to the configured address |
| `REALTIME_ALREADY_STARTED` | Invalid repeated lifecycle operation |
| `REALTIME_START_CANCELLED` | Start was cancelled during shutdown |
| `HANDSHAKE_UNAUTHORIZED` | Authentication failed |
| `HANDSHAKE_ORIGIN_REJECTED` | Browser origin is not allowed |
| `HANDSHAKE_TIMEOUT` | Authentication/handshake deadline expired |
| `MESSAGE_TOO_LARGE` | Payload exceeds configured limit |
| `SEND_BACKPRESSURED` | Local send path cannot accept more data under current policy |
| `CONNECTION_CLOSED` | Operation attempted after close |
| `HOST_INTEGRATION_INVALID` | Host integration configuration is invalid |
| `PUBLIC_URL_REQUIRED` | Proxy mode needs an externally configured URL |

Every error should include:
- stable code;
- human-readable message;
- safe metadata;
- cause where appropriate;
- retryable flag where meaningful;
- no tokens, cookies, or secret headers.

### 9.8 Developer tooling

Provide:
- `realtime.health()` for local readiness state;
- `realtime.address` and `realtime.wsUrl`;
- structured startup logs including bind host/port/path and public URL;
- a diagnostic command or function that checks native module load and configuration;
- framework-specific quickstarts;
- a reverse-proxy configuration generator/example;
- a clear error when a user configures a same-port Node HTTP integration without a proxy;
- examples for Docker, Kubernetes, Nginx, Caddy, and cloud ingress;
- a minimal browser client example and a Node client example.

---

## 10. Package structure after consolidation

Recommended layout:

```text
src/
  index.ts
  public/
    create-realtime.ts
    realtime-server.ts
    config.ts
    errors.ts
    types.ts

  host/
    host-server-adapter.ts
    node-http.ts
    express.ts
    fastify.ts
    koa.ts
    native-uws.ts

  transport/
    index.ts
    uws/
      uws-app.ts
      uws-listener.ts
      uws-websocket-route.ts
      uws-connection.ts
      uws-send.ts
      uws-close.ts
      uws-errors.ts
      uws-options.ts
    normalized/
      transport-connection.ts
      transport-message.ts
      transport-events.ts
      transport-errors.ts
    testing/
      fake-transport.ts
      transport-contract-suite.ts

  core/
    hub.ts
    lifecycle.ts
    connection-registry.ts
    principal.ts
    middleware.ts
    authorization.ts
    router.ts

  rooms/
  presence/
  events/
  collaboration/
  e2ee/
  errors/
  observability/
  shared/
```

Rules:
- Only `src/transport/uws/**` imports `uWebSockets.js`.
- `src/host/**` must not import uWS socket internals except the native uWS integration.
- `src/core/**` must not import uWS.
- `src/rooms/**`, `presence/**`, `events/**`, `collaboration/**`, and `e2ee/**` must not import uWS or framework packages.
- Do not retain both `core/hub.ts` and `core/core-hub.ts` as independent runtimes.
- Do not retain subsystem-specific WebSocket server implementations.
- Do not keep old `ws` adapter files after the migration and compatibility window.
- Keep FakeTransport under testing, not as a production engine.

---

## 11. uWebSockets.js dependency, versioning, and operational policy

### 11.1 Dependency policy

The official uWebSockets.js repository documents installation from its GitHub repository/tag rather than a conventional package-registry release in its README. The repository also describes the library as a native V8 addon. This affects installation, reproducibility, runtime compatibility, and CI. See the [official README](https://github.com/uNetworking/uWebSockets.js).

The project must:
1. Pin an exact uWS release/tag or immutable commit.
2. Avoid floating `master` or unpinned Git references.
3. Document the supported Node.js versions and operating systems.
4. Verify prebuilt native binaries or supported build requirements in CI.
5. Test clean installation from lockfile on every supported platform.
6. Document package-manager-specific Git dependency/override behavior.
7. Track upstream security and compatibility changes.
8. Avoid loading uWS from a broad `try/catch` that hides native load errors.

### 11.2 Optional versus required dependency

If uWS is the only supported WebSocket engine, it is not logically optional at runtime. There are two valid packaging choices:

**Choice A — Required dependency**
- Installation always includes uWS.
- `@oneunit/realtime` is a complete package.
- Consumers do not have to install the engine separately.
- Native install constraints apply to every consumer.

**Choice B — Explicit peer dependency**
- Consumer installs the pinned compatible uWS version.
- Useful for applications that need to control native package versions.
- Startup checks for the module and emits a clear error.
- Documentation must state that real-time transport cannot start without it.

Recommended: choose one after testing the repository's package manager and native install behavior. Do not make uWS optional while also claiming that the package always provides WebSockets.

### 11.3 Runtime compatibility matrix

Publish a table that is verified in CI:

| Dimension | Required decision |
|---|---|
| Node.js versions | Explicit minimum and tested LTS/current versions |
| Operating systems | Linux, macOS, Windows support only where upstream binaries/builds are validated |
| CPU architectures | x64/arm64 support verified independently |
| Containers | Native library and libc compatibility tested |
| TypeScript | Exact supported compiler range |
| ESM/CJS | Supported entry points tested |
| Package managers | npm/pnpm/yarn/bun installation behavior verified |
| Serverless/edge | Unsupported unless native addon and listener lifecycle are demonstrably supported |

Do not infer support from the fact that TypeScript compiles. The native module must load and operate on the actual runtime.

---

## 12. Proxy and deployment design

### 12.1 Nginx example

```nginx
upstream realtime_uws {
    server 127.0.0.1:4001;
}

upstream app_http {
    server 127.0.0.1:3000;
}

server {
    listen 443 ssl;
    server_name app.example.com;

    location /realtime {
        proxy_pass http://realtime_uws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://app_http;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

The actual proxy syntax and header behavior must be validated against the selected proxy version and deployment. The application must trust forwarded headers only when the request came from the configured proxy.

### 12.2 Deployment modes

**Local development**
- Framework HTTP on port 3000.
- uWS on port 4001.
- Browser connects directly to `ws://localhost:4001/realtime`, or local dev proxy routes `/realtime`.

**Production behind ingress**
- Public HTTPS/WSS terminates at ingress.
- Ingress routes HTTP to framework service and WebSocket path to uWS service/port.
- uWS may use internal plain HTTP only on a private network.
- Health/readiness probes check both framework and uWS readiness.

**Direct uWS**
- uWS owns TLS and public listener.
- HTTP routes are implemented in uWS or proxied to a framework backend.
- One public listener.

### 12.3 Sticky sessions and scaling

This plan consolidates the in-process architecture; it does not automatically make the Hub multi-instance.

If multiple uWS instances are deployed:
- load balancer must maintain connection affinity where required;
- room membership and presence need a shared/distributed coordination design;
- event fan-out must reach connections on other instances;
- delivery ACK and idempotency must survive instance changes;
- reconnect/resume behavior must be defined.

Do not claim horizontal multi-instance correctness merely because the uWS listener can scale. Treat distributed Hub coordination as a separate architecture phase.

---

## 13. Migration plan from the current codebase

### Phase 0 — Repository and build baseline

**Why:** The supplied archives did not include package metadata, tests, or CI. Deletion cannot be safe until all public and dynamic references are known.

Tasks:
1. Obtain full repository and lockfile.
2. Record current package exports, public types, framework integrations, examples, and downstream usage.
3. Run clean install, type-check, lint, unit tests, integration tests, build, and examples.
4. Generate import/export graph, including dynamic imports and package subpaths.
5. Record current runtime and performance baseline.
6. Add characterization tests around existing Hub, transport, room, presence, and event behavior.

Deliverables:
- Reproducible baseline.
- Public API inventory.
- Dependency graph.
- Baseline performance and reliability results.
- Candidate deletion list with confidence levels.

Exit gate:
- Build and test baseline is repeatable from a clean checkout.
- Every exported symbol has an owner and compatibility classification.

### Phase 1 — Architecture decisions

**Why:** Refactoring before deciding the canonical runtime and listener model creates another generation of duplicate code.

Create these Architecture Decision Records:

- ADR-001: `RealtimeHub` is the only canonical runtime.
- ADR-002: uWebSockets.js is the only WebSocket engine.
- ADR-003: Framework-hosted mode uses a dedicated uWS listener.
- ADR-004: Same-origin deployment uses reverse proxy routing.
- ADR-005: Native uWS app ownership and listen lifecycle.
- ADR-006: Canonical `TransportConnection` contract.
- ADR-007: One physical socket close owner.
- ADR-008: Shared authentication/principal contract.
- ADR-009: Public API and deprecation policy.
- ADR-010: Native dependency/version support policy.

Exit gate:
- No architecture document promises a generic Node HTTP `upgrade` attachment.
- No architecture document describes `ws` as a supported fallback.
- One Hub and one transport contract are named.

### Phase 2 — Build the uWS transport in isolation

**Why:** Prove the selected native engine works on supported runtimes before moving all feature modules onto it.

Tasks:
1. Pin uWS version and dependency strategy.
2. Add a minimal uWS app that listens on a test port.
3. Implement one `/realtime` WebSocket route.
4. Implement normalized connection wrapper.
5. Copy inbound message buffers before async work.
6. Map send result/backpressure statuses.
7. Implement `drain`, `dropped`, `close`, `ping`, and `pong` handling.
8. Implement max payload and idle timeout configuration.
9. Implement startup failure cleanup.
10. Implement stop/close with active connections.
11. Add transport contract tests against actual uWS.
12. Test native module loading in CI on every supported runtime/platform.

Exit gate:
- No `ws` dependency is used by the new transport.
- Native integration tests pass.
- All listener and connection resources are released on failure and shutdown.

### Phase 3 — Implement listener modes

**Why:** The framework compatibility promise depends on correct topology, not framework-specific socket hacks.

Tasks:
1. Implement native uWS mode.
2. Implement dedicated uWS listener mode.
3. Separate bind URL from public URL.
4. Expose actual bound address and `wsUrl`.
5. Add explicit port-0 behavior.
6. Add origin and trusted-proxy handling.
7. Add reverse-proxy deployment examples.
8. Reject unsupported same-port Node HTTP attachment with an actionable error.
9. Test path routing and proxy headers.

Exit gate:
- Both modes work.
- No mode silently attaches uWS to Node's `upgrade` event.
- Public URL is correct in proxied deployments.

### Phase 4 — Implement framework lifecycle integrations

**Why:** Framework users need easy startup/shutdown without coupling the core package to each framework.

Tasks:
1. Implement generic `HostServerAdapter`.
2. Implement Node HTTP lifecycle helper.
3. Implement Express integration.
4. Implement Fastify plugin.
5. Implement Koa helper.
6. Add manual integration for custom frameworks.
7. Ensure optional imports do not load framework packages in core.
8. Add integration tests that verify framework HTTP routes continue to work while uWS serves WebSockets on its dedicated listener.
9. Test graceful shutdown order and repeated lifecycle operations.

Exit gate:
- Express, Fastify, Koa, and plain Node HTTP examples work.
- Framework HTTP listener remains owned by the application.
- uWS listener remains owned by the realtime package unless ownership is explicitly transferred.
- No second WebSocket engine is installed or loaded.

### Phase 5 — Stabilize server lifecycle

**Why:** Startup races and fire-and-forget initialization can make the entire integration unreliable.

Tasks:
1. Remove constructor-triggered asynchronous startup.
2. Add `created/starting/ready/draining/closed/failed` state machine.
3. Make `start()` single-flight and await native listen success.
4. Make `close()` single-flight and bounded.
5. Remove interval polling for port readiness.
6. Make start failure observable.
7. Handle close during start.
8. Handle repeated start/close.
9. Add listener leak and resource leak tests.
10. Fix hard-coded adapter path and asynchronous room state updates.
11. Observe all send/broadcast promise failures.

Exit gate:
- No unobserved startup/shutdown promise.
- No readiness polling.
- No stale connection or room state after failure.
- Start/close behavior is deterministic.

### Phase 6 — Consolidate Hub runtime

**Why:** Transport migration will not solve duplicate Hub state if two runtimes remain.

Tasks:
1. Compare all public behavior in `core/hub.ts` and `core/core-hub.ts`.
2. Choose `RealtimeHub` as canonical based on the public API architecture and existing public facade.
3. Move required modular behavior from `Hub` into internal services.
4. Ensure one connection registry.
5. Ensure one room membership authority.
6. Ensure one disconnect coordinator.
7. Keep compatibility façade or deprecate old `Hub`.
8. Update all root/subpath exports.
9. Remove old runtime only after consumer migration and major-version decision.

Exit gate:
- Only one production runtime path.
- Existing public behavior remains covered by tests.
- No duplicate connection or membership maps.

### Phase 7 — Move all feature modules to shared transport

**Why:** Presence and Rooms/Namespaces must not own parallel WebSocket lifecycles.

Tasks:
1. Replace presence socket adapters with normalized connections.
2. Replace room/namespace socket adapters with normalized connections.
3. Remove feature-specific WebSocket servers.
4. Preserve feature-specific message mapping and authorization.
5. Ensure Hub owns connection lifecycle.
6. Ensure Room service owns membership.
7. Ensure Presence derives from Hub connection/lease events.
8. Ensure Event service owns ACK/retry/delivery state.
9. Ensure Collaboration owns CRDT and durable document state.
10. Ensure E2EE owns key epoch/envelope rules.

Exit gate:
- Only the uWS transport layer imports uWS.
- No feature module owns a physical WebSocket.
- Cross-service lifecycle tests pass.

### Phase 8 — Public API and DX migration

**Why:** The internal architecture should not leak complexity to developers.

Tasks:
1. Introduce `createRealtime()` as the simple entry point if it improves on current `createRealtimeHub()` ergonomics.
2. Preserve `createRealtimeHub()` as an alias or compatibility API where possible.
3. Introduce `start()` / `close()` explicit lifecycle.
4. Add `wsUrl`, `address`, and health status.
5. Add framework subpath helpers.
6. Add stable typed errors.
7. Add typed event schemas and room APIs.
8. Add migration examples.
9. Mark old transport and Hub APIs deprecated.
10. Publish breaking changes only in a major release.

Exit gate:
- One recommended quickstart per framework.
- API docs show exact listener topology.
- No hidden fallback or listener ownership behavior.

### Phase 9 — Delete obsolete code and docs

**Why:** Deleting before migration would risk removing functionality that has no replacement.

Candidates, subject to full-repository verification:
- `ws-transport.ts`
- `adapter.ts` legacy multi-engine implementation
- `createWsTransport()` and `ws`-specific factory branches
- `core/core-hub.ts` after compatibility migration
- presence-specific WebSocket server/connection wrappers
- room-namespace-specific WebSocket server/connection wrappers
- duplicate `AuthProvider` contract
- test fake from production transport folder, moved to test support
- duplicate Rooms/Namespaces architecture document
- one of the near-identical Transport Adapter documents
- stale architecture plans after unique decisions are migrated

Before deleting each candidate:
1. Search all source imports.
2. Search package exports and subpath exports.
3. Search examples, tests, scripts, build config, and dynamic imports.
4. Search downstream consumers where available.
5. Verify replacement behavior and tests.
6. Add a deletion/migration note.
7. Remove in a separate reviewable change.

Exit gate:
- No unresolved import/export.
- No supported public API removed without a deprecation/major-version decision.
- Full tests, build, examples, and package verification pass.

### Phase 10 — Production readiness

Tasks:
1. Load test concurrent connections and fan-out.
2. Test slow consumers and backpressure.
3. Test abrupt client disconnects.
4. Test uWS listener failure and restart.
5. Test proxy timeout and upgrade routing.
6. Test TLS termination and trusted forwarded headers.
7. Run soak tests for listener, timer, and memory leaks.
8. Run security tests for origin, auth, tenant isolation, oversized payloads, and E2EE.
9. Publish supported runtime matrix.
10. Publish operational runbook and migration guide.

Exit gate:
- Performance and memory meet agreed targets.
- No resource leaks in soak tests.
- All security and lifecycle tests pass.
- Deployment documentation is validated against actual proxy configurations.

---

## 14. Testing strategy

### 14.1 Transport contract suite

Every transport connection must satisfy:
- binary and text message normalization;
- payload copied before async processing;
- send acceptance/backpressure/error mapping;
- correct buffered byte reporting;
- drain notification;
- dropped-message handling;
- close once only;
- listener unsubscribe;
- send after close rejected;
- max payload enforcement;
- idle timeout and ping/pong behavior;
- startup failure cleanup;
- shutdown with active connections.

Because uWS is the only engine, the suite runs against:
- real uWS integration;
- FakeTransport for deterministic Hub unit tests.

Do not retain a `ws` adapter merely to run generic tests.

### 14.2 Framework integration matrix

| Test | Node HTTP | Express | Fastify | Koa | Native uWS |
|---|---:|---:|---:|---:|---:|
| Existing HTTP route still works | Yes | Yes | Yes | Yes | Yes |
| uWS listener starts | Yes | Yes | Yes | Yes | Yes |
| WebSocket connects | Yes | Yes | Yes | Yes | Yes |
| Host shutdown closes uWS | Yes | Yes | Yes | Yes | N/A/owner-defined |
| Proxy public URL correct | Yes | Yes | Yes | Yes | Yes |
| Invalid Origin rejected | Yes | Yes | Yes | Yes | Yes |
| No duplicate socket close | Yes | Yes | Yes | Yes | Yes |

### 14.3 Failure injection

- uWS native module missing.
- Native binary incompatible with Node runtime.
- Port already occupied.
- uWS listen callback reports failure.
- Shutdown during startup.
- Client disconnect during auth.
- Auth promise never resolves.
- Message callback receives a large frame.
- Slow client triggers backpressure.
- `dropped` callback fires.
- Proxy sends incorrect forwarded headers.
- Host HTTP server closes before uWS.
- uWS closes before host HTTP server.
- Duplicate framework shutdown hook.
- Repeated start/close.
- Process receives SIGTERM during active delivery.

### 14.4 Performance and memory

Measure:
- connection establishment rate;
- concurrent open connections;
- p50/p95/p99 message latency;
- fan-out throughput;
- buffered bytes per socket;
- dropped frames;
- event loop delay;
- RSS and heap;
- native memory where observable;
- CPU under compression;
- shutdown duration.

Do not rely on generic vendor benchmark claims. Benchmark this package's real protocol, middleware, auth, serialization, fan-out, and workload.

---

## 15. Security requirements

1. Validate browser Origin with explicit allowlist.
2. Define native-client no-Origin behavior.
3. Validate subprotocol if used.
4. Authenticate before creating fully privileged Hub state.
5. Use bounded handshake deadline and cancellation.
6. Avoid long-lived secrets in query strings.
7. Trust forwarded headers only from trusted proxies.
8. Keep internal uWS listener private when behind a proxy.
9. Enforce one canonical max payload before parsing.
10. Enforce per-connection and per-principal rate limits.
11. Enforce tenant/namespace/room authorization at each operation.
12. Never treat room membership as authorization.
13. Required E2EE mode rejects plaintext and stale key epochs.
14. Do not log cookies, tokens, session IDs, or ciphertext metadata that is considered sensitive.
15. Bound queues, fan-out concurrency, retry count, and shutdown wait.
16. Ensure `dropped` and backpressure events update delivery state rather than silently losing durable messages.

---

## 16. Documentation and repository structure

Recommended canonical docs:

```text
docs/
  architecture/
    system-overview.md
    deployment-topologies.md
    decisions/
      ADR-001-canonical-hub.md
      ADR-002-uws-only-transport.md
      ADR-003-framework-integration.md
      ADR-004-lifecycle-ownership.md
      ADR-005-public-api.md

  services/
    core-hub.md
    transport-uws.md
    framework-integration.md
    rooms-and-namespaces.md
    presence.md
    events-and-delivery.md
    collaboration.md
    e2ee.md
    middleware.md
    error-handling.md
    public-api.md

  guides/
    getting-started.md
    express.md
    fastify.md
    koa.md
    node-http.md
    native-uws.md
    reverse-proxy.md
    docker.md
    kubernetes.md
    migration-from-ws.md
    troubleshooting.md

  implementation/
    consolidation-plan.md
    release-plan.md
    testing-plan.md
    operations-runbook.md
```

Rules:
- Architecture docs define invariants and contracts.
- Guides show working code.
- Implementation plans define sequence and acceptance gates.
- ADRs explain decisions and rejected alternatives.
- Do not repeat normative contracts in multiple documents.
- Validate links in CI.
- Every topology diagram must identify which process owns each listener.

---

## 17. Release and migration strategy

### Release 1 — Preparation
- Add uWS transport behind new internal interface.
- Add framework integrations in dedicated-listener mode.
- Keep existing API as compatibility layer.
- Do not yet delete `ws` code if existing public users depend on it.
- Mark old transport selection as deprecated.

### Release 2 — uWS default and migration
- Make uWS the only supported engine in the new API.
- Provide explicit migration path for old `ws` configurations.
- Emit deprecation warnings for old factory and transport types.
- Update docs and examples.
- Verify downstream applications.

### Release 3 — Breaking cleanup
- Remove `ws` dependency and adapters.
- Remove old competing Hub runtime if migration is complete.
- Remove subsystem-specific transport implementations.
- Remove duplicate docs and obsolete exports.
- Publish major-version migration notes.

If the package has not yet been released publicly, this can be one major implementation sequence rather than three public releases. Still keep the work in reviewable phases.

---

## 18. Definition of done

### Architecture
- One canonical Hub runtime.
- One connection registry.
- One WebSocket engine: uWebSockets.js.
- One normalized transport contract.
- One owner for physical socket close.
- Framework adapters own lifecycle integration only.
- Dedicated listener/proxy topology is explicit.
- No promise of arbitrary same-port Node HTTP attachment.

### Code
- Only transport implementation imports uWS.
- No `ws` package or `WebSocketServer` implementation remains.
- No subsystem-specific WebSocket server remains.
- No duplicate connection contracts remain without compatibility adapters.
- No silent fallback exists.
- No unhandled lifecycle promises.
- No dead timers/listeners/registries.
- Public exports are intentional.

### DX
- One recommended `createRealtime()` API.
- Explicit awaited `start()` and `close()`.
- Correct `wsUrl` and bound address.
- Express, Fastify, Koa, Node HTTP, native uWS, and generic host examples.
- Framework packages are optional.
- Errors are typed and actionable.
- Same-origin proxy configuration is documented.

### Reliability and security
- Startup/shutdown race tests pass.
- Backpressure and dropped-send tests pass.
- Origin, auth, proxy, and tenant-isolation tests pass.
- E2EE policy tests pass.
- Load and soak tests meet agreed targets.
- Native runtime compatibility matrix is verified.

---

## 19. Open decisions that must be resolved before implementation

1. **uWS dependency strategy:** bundled required dependency or explicit peer dependency?
2. **Supported Node versions:** what exact minimum and LTS matrix must be supported?
3. **Operating systems:** which OS/CPU combinations are release blockers?
4. **Framework integration packaging:** one package with optional subpaths or separate `@oneunit/realtime-express`, `-fastify`, and `-koa` packages?
5. **Listener ownership:** should `createRealtime()` own listen by default, or should native mode expose `mount()` and leave listen ownership to the caller?
6. **Public URL:** required in proxy mode or derivable from trusted deployment configuration?
7. **Authentication:** cookie/session validation, bearer token, or one-time ticket as the recommended default?
8. **Same-origin deployment:** is a reverse proxy acceptable as the standard framework-hosted deployment requirement?
9. **Public API compatibility:** which existing `Realtime`, `RealtimeHub`, `Connection`, and `Hub` APIs must remain through a deprecation window?
10. **Multi-instance scope:** is distributed room/presence/event coordination explicitly out of scope for this consolidation?

These are product and compatibility decisions, not details to bury inside implementation code.

---

## 20. Final recommendation

Build the package around **one canonical Hub and one uWebSockets.js transport host**. Treat framework compatibility as a host-lifecycle and deployment integration problem, not as a reason to create a second WebSocket engine or emulate every framework's internal socket handling.

For Express, Fastify, Koa, and plain Node HTTP, use a dedicated uWS listener and document reverse-proxy routing. For applications willing to use uWS as their primary listener, offer native mode. For custom frameworks, expose the generic lifecycle adapter.

This design is explicit about the real server boundary, removes duplicated transport implementations, keeps framework dependencies out of the core, and gives developers a predictable API. It also makes the codebase easier to test: the Hub is tested against a normalized connection contract, the uWS adapter is tested against the actual native library, and framework plugins are tested for lifecycle integration rather than WebSocket protocol behavior.

**Consolidate responsibilities first, migrate behavior second, and delete obsolete code only after the replacement is proven.**
