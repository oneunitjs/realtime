# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## 2.0.0 - 2026-10-05

### Breaking

Three independent breaking changes land in this major.

1. **The package is now `@oneunit/realtime`** (renamed from
   `@oneunit/realtime`). Every subpath changed with it:
   `@oneunit/realtime/adapter`, `/plugin`, `/fastify`, `/hub` and `/e2ee`. The
   old scope is no longer published, so update the dependency and all imports.
   This follows the same rename already applied to `@oneunit/auth`,
   `@oneunit/database`, `@oneunit/errors`, `@oneunit/logger` and
   `@oneunit/redis`.
2. **Kafka removed.** The bridge is gone from this package: `src/kafka-bridge.ts`,
   `test/kafka-bridge.test.ts`, `examples/kafka-bridge.ts`, the
   `@oneunit/realtime/kafka-bridge` subpath, and every Kafka export
   (`createKafkaBridge`, `KafkaBridge`, `KafkaBridgeConfig`, `KafkaTopicHandler`,
   `KafkaClientLike`, `KafkaBridgeLogger`, `KafkaConsumer`, `KafkaMessage`,
   `EachMessagePayload`). Removing a published export is why this is a major.
3. **Authentication and authorization hooks make membership and delivery
   asynchronous.** `join()`, `leave()`, `disconnect()`, `send()` and
   `broadcast()` now return promises and may reject with a typed error.

   ```typescript
   // before
   hub.join("room", { id, socket });
   const delivered = hub.broadcast("room", message);

   // after
   const client = await hub.join("room", { id, connection: socket });
   const delivered = await hub.broadcast("room", message);
   ```

   Hooks must be able to await a policy or identity service, and a synchronous
   `join()` cannot do that. A denied operation throws `AuthorizationError` or
   `AuthenticationError` rather than returning a falsy value.

Other API changes to migrate:

| Before                                | After                                                              |
| ------------------------------------- | ------------------------------------------------------------------ |
| `{ id, socket }`                      | `{ id, connection }` — `socket` renamed to match `RealtimeConnection` |
| `hub.send({ id, socket }, msg)`       | `hub.send(client, msg)`, where `client` comes from `join()`            |
| `hub.join(ch, socket)` (raw socket)   | still accepted; a connection with `send()`/`close()` is all it needs  |
| `{ except: [...] }`                   | `{ exclude: [...] }`                                                 |
| `hub.stats()` → `sent`, `dropped`, `errors`, `closed`, `clients` | `messagesSent`, `messagesDropped`, `sendFailures`, `connections`, plus `hub.isClosed` and `hub.clientCount()` |
| `hub.enableE2EE()`                    | `createRealtimeHub({ e2ee: true })`                                  |
| `hub.getPublicKey()`                  | `hub.e2eePublicKey`                                                  |
| `hub.registerClientKey(clientId, key)` | `hub.registerClientKey(connection, key)`                           |
| `hub.isE2EEEnabled()`                 | `hub.isE2EEEnabled` (property)                                       |
| `hub.isE2EEEnabled` + `sendEncrypted` plaintext fallback | encrypted sends now reject with `ConnectionError` when no key is registered |
| `onError` hub option                  | `logger` and `onEvent`                                               |
| `maxBufferedBytes` / `maxConsecutiveDrops` | `backpressure: { maxBufferedBytes, maxConsecutiveDrops }`     |
| `heartbeatInterval` / `startHeartbeat({ interval })` | `heartbeatInterval` / `startHeartbeat({ intervalMs })`  |
| `broadcastPublicInteraction()`        | removed — a domain-specific helper that belonged in the application   |
| `decryptMessage`                      | removed — use `hub.decryptFromClient(connection, frame)`              |
| `hub.channels` (Map), `hub.sharedKeys`| removed — no internal state is exposed; use `channelNames()`, `stats()` |
| `RealtimeSocket`                      | `Connection`, the minimal transport contract                          |
| `Channel`                             | removed — channels are plain strings                                  |
| `HubErrorContext`                     | replaced by `RealtimeEvent` / `RealtimeEventName`                     |

### Removed

- `@oneunit/kafka` is no longer a dev dependency, an optional peer, or a
  keyword, and the lockfile no longer links the workspace package. Nothing in
  this package imports a broker, so the installed dependency tree is `ws`,
  `notepack.io`, and `libsodium-wrappers` only.
- `broadcastPublicInteraction()`, a domain-specific helper that hardcoded
  `record` / `like` semantics into an infrastructure package.

### Added

- `src/adapter.ts`: the transport integration, shared by every server.
  `createConnectionAdapter()` provides authenticate → join → route → clean up over
  anything satisfying the `Connection` contract, and
  `attachWebSocketAdapter()` adds the `ws` upgrade for any `node:http` /
  `node:https` server (including Fastify's `app.server`). Exported from the root
  and from the new `@oneunit/realtime/adapter` subpath.
  `src/plugin.ts` is now a binding over this adapter rather than a second copy of
  the same rules.
- `ConnectionAdapter.authenticate()`, for transports that can refuse a peer before
  its handshake completes.
- `decodeMessage(frame, isBinary?)` takes the transport's binary flag. Everything
  the hub sends is binary notepack, but a client may send JSON text, which the
  notepack decoder rejects with "trailing bytes"; passing `isBinary: false` reads
  it as JSON. Unparseable text is returned unchanged instead of throwing.
- `ARCHITECTURE.md` (why the package is split this way) and `CONTRIBUTING.md`
  (security-first rules for changes). Both ship in the tarball.
- `BroadcastTarget`, the hub surface an external adapter needs: a single
  `broadcast(channel, message, options?)`. Event brokers stay in the
  application, so horizontal scaling is an adapter that consumes from the broker
  of its choice and calls `broadcast`.
- `examples/adapter.ts` shows that seam end to end without introducing a broker
  into this package.
- Typed error hierarchy in `src/errors.ts`: `RealtimeError`, `ConnectionError`,
  `ConnectionClosedError`, `ChannelError`, `AuthenticationError`,
  `AuthorizationError`, `MessageTooLargeError`, `ConnectionLimitError`. Every
  error carries a machine-readable `code`.
- Optional `authenticate` and `authorize` hooks, covering connection, join, send
  and broadcast. Neither the hub nor the plugin knows what a token, role or
  permission is.
- Capacity limits: `maxConnections`, `maxClientsPerChannel`,
  `maxChannelsPerClient`, `maxMessageSize`, `maxChannelNameLength`, with safe
  defaults and typed errors.
- Shared heartbeat scheduler with configurable interval and timeout, stale
  connection cleanup, and `hub.touch(clientId)` for transports without `ping()`.
- `onEvent` observability hook and a wider `stats()` counter set
  (`messagesDropped`, `sendFailures`, `authorizationsDenied`, `heartbeatsSent`,
  `connectionsTerminated`, …).
- Optional `logger` interface (`debug`/`info`/`warn`/`error`). Nothing is logged
  unless a logger is passed.
- `attachConnections: false` for apps that define their own `websocket` routes.
- `broadcastRaw()`, `sendRaw()`, `sendEncrypted()`, `broadcastEncrypted()`,
  `client()`, `hasChannel()`, `channelNames()`, `channelsFor()`, `clientCount()`,
  `attachMetadata()`, `isClosed`, `isHeartbeatRunning`.
- E2EE frames are now self-describing: `{ type: "e2ee", ciphertext }`.

### Fixed

- **A JSON text frame is decodable again.** `decodeMessage()` assumed every frame
  was binary, so reading a client's plain-text message threw `trailing bytes`
  from inside the notepack decoder. It now accepts the transport's `isBinary`
  flag, and encrypted payloads (which are binary) keep working unchanged.
- **A refused peer no longer holds an open socket.** When the adapter owns the
  upgrade, `attachWebSocketAdapter()` now runs the authentication hook *before*
  completing the handshake and answers a refused peer with `401` (or `503` once
  the hub is closed). Previously the peer received a completed WebSocket
  connection that was immediately closed with `1008`, which counted as a
  connection to the client and to anything watching. A transport whose handshake
  is already complete still closes with `refusedCloseCode` (`1008`), because an
  HTTP status is no longer available at that point.
- **Shutdown no longer hangs.** A hijacked WebSocket upgrade socket keeps Node's
  HTTP server from closing, so `app.close()` used to wait forever. Teardown now
  runs in Fastify's `preClose` hook, terminates live sockets and removes the
  upgrade listener. `hub.close()` is idempotent.
- **notepack frames decoded correctly.** `decodeMessage()` wraps a bare
  `Uint8Array` in a `Buffer`; notepack's decoder reads through the `Buffer` API
  and previously threw on a plain typed array.
- Empty channels are no longer left behind by a denied join, and a client whose
  join is refused is released instead of lingering without channels.
- A failed `send()` is no longer counted as delivered, and `broadcast()` returns
  the number of connections actually written to.
- `decryptFromClient()` derives the correct side of the shared secret, so
  client-encrypted frames round-trip.
- Heartbeat pings are skipped for connections whose transport cannot ping, and
  the scheduler is `unref`'d so it never keeps a process alive.
- Internal Maps and Sets are no longer reachable: `participants()`, `client()` and
  their metadata and channel sets are frozen snapshots.
- **A refused socket can no longer take the process down.** `ws` reports a socket
  closed before its handshake finished by emitting `error` on a later tick, and
  every rejection path closed the socket before an `error` listener was wired. An
  `EventEmitter` with no `error` listener turns that into an uncaught exception,
  so a peer the server refused could crash it. The adapter now absorbs that error
  before closing.
- **`broadcastEncrypted()` no longer loses every message silently.** On a hub
  built without `{ e2ee: true }` there are no keys, so each member was skipped
  and the call returned `0` — indistinguishable from an empty channel. It now
  rejects with `ConnectionError`, matching `sendEncrypted()`.
- `attachMetadata()` returns `false` for a patch that is not a plain object
  instead of spreading it into indexed characters.
- Two adapters on one server are refused with a `TypeError` at attach time rather
  than leaving the second one silently starved of connections.

### Changed

- Package description, README, and docs describe a WebSocket package rather than
  a bridge, and document the single-process and load-balanced topologies.
- The core depends on a minimal `Connection` contract (`send`, `close`,
  `readyState`, optional `terminate`/`ping`/`bufferedAmount`) instead of a
  `ws`-shaped socket. `src/hub.ts` and `src/errors.ts` import neither `ws` nor
  Fastify, and only `src/plugin.ts` imports Fastify; `test/boundaries.test.ts`
  fails if that changes.
- `ws` is a runtime dependency rather than an optional peer, because
  `attachWebSocketAdapter()` is a supported integration rather than a hobby. It
  is still imported lazily, so a Fastify-only app never loads it, and
  `@fastify/websocket` and `fastify` remain optional peers.
- README documents the byte-accounting limitation honestly: `maxBufferedBytes`
  depends on `bufferedAmount`, which the WHATWG `WebSocket` API does not expose.

## 1.1.0 - 2026-10-05

### Fixed

- `hub.enableE2EE()` no longer throws on a cold start. `libsodium` initialises
  asynchronously, so the key pair is generated when it is first needed and
  `registerRealtime` awaits `e2eeReady()`.
- Sockets are no longer compared against the global `WebSocket.OPEN`, which
  threw `ReferenceError` on Node 20 and on any runtime without a global
  `WebSocket`.
- `leave()` no longer drops a client, and its E2EE key, while it still belongs
  to another channel.
- One socket throwing on `send()` no longer aborts a broadcast to the remaining
  members, and it is no longer counted twice in `stats().errors`.
- The `ws` mode no longer leaks upgrade sockets for unmatched paths, closes its
  `WebSocketServer` and removes its `upgrade` listener on `app.close()`, and
  attaches `error` handlers so a socket error cannot take the process down.
- The documented `@fastify/websocket` example was wrong for v11: the route
  handler receives the socket as its first argument, not `{ socket }`. Every
  shipped example was rewritten, `examples/native-ws.ts` no longer contains a
  syntax error, and `examples/e2ee.ts` no longer imports functions that were
  never exported.
- `registerRealtime` no longer registers `@fastify/websocket` twice when the
  application already registered it.
- `lint` passes: 10 unused-variable and `any` errors in `src` and `test`.
- Package `repository`, `homepage` and the README monorepo link point at the
  same repository, and `src/` ships so the published sourcemaps resolve.

### Added

- `maxPayload` (1 MiB by default) for both WebSocket libraries; oversized frames
  close the connection with 1009.
- Heartbeat pings with dead-peer termination, enabled by default through the
  plugin and available as `hub.startHeartbeat()`.
- Backpressure handling: frames are skipped above `maxBufferedBytes` and a
  client that stays over the limit is terminated instead of buffering forever.
- `sendRaw`, `broadcastRaw`, `encryptForClient` and `decryptFromClient` for
  applications that own their wire format or need per-client encryption.
- `disconnect`, `channelsFor`, `channelNames`, `hasChannel`, `hasClient`,
  `clientCount` and `stats()`.
- `e2eeReady()`, `isE2EEReady()` and `createHubKeyPair()` so readiness is
  explicit instead of an exception.
- `@oneunit/realtime/fastify` for the `app.realtime` type
  augmentation.
- Input validation in the E2EE helpers: key lengths, ciphertext length, and
  malformed base64 or hex now fail with a named error instead of a libsodium
  panic or silent empty buffer.
- `onError` on hub options, `onConnection` / `onMessage` for `ws` mode, and a
  dedicated `logger`.
- Integration tests against a real Fastify server and real `ws` clients, plus
  `typecheck:test`, `typecheck:examples` and `verify` scripts.
- A release workflow mirroring the sibling packages: verify matrix, consumer
  smoke test, tag-gated publish.

### Changed

- `Client.socket` is a structural `RealtimeSocket` instead of the global
  `WebSocket` type, and the package no longer augments the global `WebSocket`
  interface. Cast to `ws` when a consumer needs `on()` or `terminate()`.
- `send`, `sendRaw`, `sendEncrypted` and `createRealtimeHub` report success and
  accept options; `broadcast` and `broadcastRaw` return the delivered count.
- `createRealtimeHub` is exported from the package root and `./hub` instead of
  only `./plugin`.
- `registerRealtime` rejects an unknown `websocketLibrary` and a second
  registration on the same instance.

## 1.0.0 - 2026-09-26

### Added

- In-memory channel hub and Fastify WebSocket plugin
- Optional Kafka bridge with local client types
- E2EE helpers via libsodium
- TypeScript declarations, tests, examples, and npm package metadata

### Changed

- Published independently as `@oneunit/realtime`
- Kafka is an optional peer, not a required runtime dependency
