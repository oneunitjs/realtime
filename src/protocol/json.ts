/**
 * JSON codec implementation.
 *
 * JSON is the most approachable default for browser debugging and
 * zero-extra-decoder examples. It is human-readable and works with every
 * WebSocket client without a custom decoder, at the cost of larger frames
 * and slower parse than MessagePack.
 *
 * Values that are not valid JSON (e.g. `undefined`, `Symbol`, `BigInt`)
 * are dropped or coerced by `JSON.stringify`; callers should ensure
 * payloads are JSON-serializable.
 */

import type { Codec } from "./types.js";

/** JSON codec. */
export const jsonCodec: Codec = {
  encode(value: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value));
  },

  decode(bytes: Uint8Array): unknown {
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text);
  },
};
