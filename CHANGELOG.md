# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## 1.0.0-beta - 2026-11-10

### Added

- In-memory channels (rooms) for local fan-out between connections
- Document subscriptions with read/write permission gating
- Transport-independent core hub (no WebSocket or framework dependency)
- uWebSockets.js transport adapter (`@oneunit/realtime/transport`)
- Adaptive backpressure with per-connection queued-byte limits
- Shared heartbeat timer with configurable ping/pong timeout
- Asynchronous authentication and authorization hooks
- Typed error hierarchy with stable machine-readable codes
- Optional Libsodium end-to-end encryption (X25519, HKDF-SHA-256,
  XSalsa20-Poly1305, Ed25519) routed opaquely by the hub
- CRDT collaboration engine (RGA, LWW-Map, version vectors)
- Node.js lifecycle hooks (Express, Fastify, Koa, `node:http`)
- Granular subpath exports: `/hub`, `/transport`, `/e2ee`, `/errors`, `/protocol`, `/collab`

### Changed

- `version` bumped from `2.0.0` to `1.0.0-beta`
- `@types/express`, `express`, `fastify` moved from `dependencies` to
  `devDependencies` (not imported by source code)
- `package.json` `files` now includes `dist`, `src`, `examples`, `docs`,
  `LICENSE`, `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md`
- Subpath exports corrected: `./error` (was `./errors`), `./e2ee` points to
  `dist/e2ee/index.js` (was `dist/e2ee/primitives.js`)

### Fixed

- **E2EE replay protection**: replay guard commit moved after signature
  verification and AEAD decryption; failed messages no longer consume replay
  state. Guard interface changed from `accept()` to split `check()` /
  `commit()`.
- **E2EE signature validation**: signatures must be exactly 64 bytes; shorter
  or longer signatures are rejected before verification.
- **E2EE recipient-bound key derivation**: `seal()` and `open()` now use the
  identical HKDF context including the first recipient device ID.
- **Authorization defaults**: `authorize()` callback must return explicit
  `true`; `undefined` no longer grants access.
- **Room publishing**: sender membership is now enforced before client-originated
  room publishing.
- **Tenant isolation**: room indexes keyed by tenant-qualified room key
  (`encodeRoomKey(tenantId, namespaceId, roomId)`) instead of bare `roomId`,
  preventing cross-tenant room name collisions.
- **Join/disconnect race**: membership rolled back if connection disconnects
  during the async join boundary.
- **Shutdown**: `Hub.close()` is now `async` and awaits all connection
  disconnects before resolving.
- **Metrics**: `rooms` reports actual room count (was hardcoded 0);
  `documents` and `subscriptions` report separate counters.
- **Publish routing**: `router.publishToRoom()` receives tenant-qualified
  roomKey instead of bare roomId.
- **README**: XChaCha20-Poly1305 corrected to XSalsa20-Poly1305 (matching
  implementation); removed unsupported microsecond/millions/zero-trust claims;
  test count corrected to 201.

## 1.0.0 - 2026-10-05

Initial release as `@oneunit/realtime@1.0.0`. In-memory channels, fan-out,
backpressure, heartbeats, auth/authorization hooks, uWebSockets.js transport
adapter, Libsodium E2EE helpers, and CRDT collaboration. Single-process,
zero-broker, transport-neutral core.
