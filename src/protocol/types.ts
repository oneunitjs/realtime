/**
 * Protocol contract types for `@oneunit/realtime`.
 *
 * Defines the versioned wire envelope, the codec interface, and the
 * frame encoder/decoder used by both the server hub and client SDK.
 *
 * Implements the protocol section of docs/public-api-improvement-plan.md
 * (Phase 3 --- Protocol and Codec).
 */

import type { PublicError } from "../error/types.js";
import { jsonCodec } from "./json.js";
import { messagepackCodec } from "./messagepack.js";

/** Current wire protocol version. Bump on any incompatible envelope change. */
export const PROTOCOL_VERSION = 1;

/**
 * Versioned wire envelope shared by server and clients.
 *
 * Every message crossing the transport is wrapped in this envelope so the
 * receiver can validate the protocol version, route by `type`, correlate
 * via `messageId`, and surface structured `error` frames without leaking
 * internal implementation details.
 */
export interface RealtimeEnvelope<T = unknown> {
  protocolVersion: number;
  messageId?: string;
  type: string;
  channel?: string;
  payload?: T;
  error?: PublicError;
}

/**
 * Codec contract: converts between JavaScript values and wire bytes.
 *
 * Implementations must be deterministic and safe for untrusted input: a
 * malformed byte sequence must throw a descriptive error rather than
 * corrupting process state.
 */
export interface Codec {
  /** Encode a JavaScript value into wire bytes. */
  encode(value: unknown): Uint8Array;

  /** Decode wire bytes into a JavaScript value. */
  decode(bytes: Uint8Array): unknown;
}

/** Supported codec names. */
export type CodecName = "json" | "messagepack";

/**
 * Result of decoding a frame: the parsed envelope plus the raw bytes that
 * were consumed, so callers can detect trailing data or framing errors.
 */
export interface DecodedFrame {
  envelope: RealtimeEnvelope<unknown>;
  consumedBytes: number;
}

/**
 * Options for frame encoding.
 */
export interface EncodeFrameOptions {
  /** Codec to use. Defaults to `"messagepack"`. */
  codec?: CodecName;
  /** Whether to include the protocol version. Always true in practice. */
  protocolVersion?: number;
}

/**
 * Encode a typed envelope into wire bytes using the selected codec.
 *
 * Throws on encode failure. Callers must catch and convert to a safe
 * error frame before sending to a client.
 */
export function encodeFrame<T = unknown>(
  envelope: RealtimeEnvelope<T>,
  options: EncodeFrameOptions = {},
): Uint8Array {
  const { codec = "messagepack", protocolVersion = PROTOCOL_VERSION } = options;

  const normalized: RealtimeEnvelope<unknown> = {
    ...envelope,
    protocolVersion,
  };

  const encoder = resolveCodec(codec);
  return encoder.encode(normalized);
}

/**
 * Decode wire bytes into a typed envelope using the selected codec.
 *
 * Throws `VERSION_UNSUPPORTED` when the envelope's protocol version does
 * not match the local `PROTOCOL_VERSION`. Throws a validation error on
 * malformed envelopes.
 */
export function decodeFrame(
  bytes: Uint8Array,
  options: { codec?: CodecName } = {},
): DecodedFrame {
  const { codec = "messagepack" } = options;
  const decoder = resolveCodec(codec);

  let raw: unknown;
  try {
    raw = decoder.decode(bytes);
  } catch (error) {
    throw new Error(
      `Failed to decode frame: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const envelope = validateEnvelope(raw);

  return {
    envelope,
    consumedBytes: bytes.byteLength,
  };
}

/**
 * Resolve a codec by name. Throws on unknown codec names.
 */
function resolveCodec(name: CodecName): Codec {
  if (name === "json") {
    return jsonCodec;
  }
  if (name === "messagepack") {
    return messagepackCodec;
  }
  throw new Error(`Unsupported codec: ${name}`);
}

/**
 * Validate a decoded raw value as a RealtimeEnvelope.
 *
 * Enforces the presence of `protocolVersion` and `type`, and rejects
 * unsupported protocol versions with a descriptive error.
 */
function validateEnvelope(raw: unknown): RealtimeEnvelope<unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid envelope: expected an object");
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.protocolVersion !== "number") {
    throw new Error("Invalid envelope: missing protocolVersion");
  }

  if (obj.protocolVersion !== PROTOCOL_VERSION) {
    const err = new Error(
      `Unsupported protocol version: ${obj.protocolVersion}, expected ${PROTOCOL_VERSION}`,
    ) as Error & { code?: string };
    err.code = "VERSION_UNSUPPORTED";
    throw err;
  }

  if (typeof obj.type !== "string") {
    throw new Error("Invalid envelope: missing type");
  }

  return obj as unknown as RealtimeEnvelope<unknown>;
}
