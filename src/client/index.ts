/**
 * `@oneunit/realtime/client` — first-party client SDK.
 *
 * Browser-safe entry point. Imports no server-only dependencies
 * (`uwebsocket`, `fastify`, `express`, `libsodium-wrappers`).
 *
 * Implements docs/public-api-improvement-plan.md (Phase 5 --- Client SDK)
 * and docs/dx-improvement-plan.md (Section 7).
 */

export {
  createRealtimeClient,
  type RealtimeClient,
  type ConnectionState,
} from "./client.js";
export type {
  RealtimeClientOptions,
  ClientAuth,
  ReconnectOptions,
} from "./client.js";
export {
  RealtimeClientChannel,
} from "./channel.js";
export type {
  ClientMessageHandler,
  ClientPresenceHandler,
  ClientUnsubscribe,
} from "./channel.js";
export type { WebSocketTransport } from "./transport.js";
export type {
  WebSocketTransportOptions,
} from "./transport.js";
export { createWebSocketTransport } from "./transport.js";
