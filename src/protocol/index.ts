/**
 * Protocol module for `@oneunit/realtime`.
 *
 * Provides a shared, versioned wire protocol and codec contract so server,
 * browser, and Node clients all speak the same format without each
 * implementing private framing.
 *
 * Imports from this subpath do not pull transport or server-only
 * dependencies (`uwebsocket`, `fastify`, `express`).
 */

export {
  PROTOCOL_VERSION,
  type RealtimeEnvelope,
  type Codec,
  type CodecName,
  type DecodedFrame,
  type EncodeFrameOptions,
  encodeFrame,
  decodeFrame,
} from "./types.js";

export { jsonCodec } from "./json.js";
export { messagepackCodec } from "./messagepack.js";
