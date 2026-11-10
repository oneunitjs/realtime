/**
 * Transport adapters — uWebSockets.js is the sole production WebSocket engine.
 *
 * Re-exports the uWS transport adapter and the normalised TransportConnection
 * contract. The Core Hub only ever sees a TransportConnection; concrete WebSocket
 * libraries are confined to this layer.
 */

export {
  UwsTransportAdapter,
  createUwsTransport,
  type UwsTransportAdapterOptions,
} from "./uws/uws-transport.js";

export {
  createRealtimeTransport,
  type RealtimeTransport,
} from "./create-transport.js";

export type {
  TransportConnection,
  TransportMessage,
  SendResult,
  SendOptions,
  TransportCloseEvent,
  Unsubscribe,
} from "../core/connection/connection.types.js";
