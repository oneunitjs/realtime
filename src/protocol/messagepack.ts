/**
 * MessagePack codec implementation using `notepack.io`.
 *
 * MessagePack produces compact binary frames and is the historic wire
 * format used by `@oneunit/realtime`. It is well-suited to server-to-server
 * and SDK-to-server links where frame size and parse speed matter, but it
 * requires a decoder on the client side.
 *
 * `notepack.io` encodes/decode objects, arrays, strings, numbers, booleans
 * and `null`. `undefined` is encoded as `nil` and decodes back as `null`.
 */

import { decode, encode } from "notepack.io";
import type { Codec } from "./types.js";

/** MessagePack codec. */
export const messagepackCodec: Codec = {
  encode(value: unknown): Uint8Array {
    return new Uint8Array(encode(value));
  },

  decode(bytes: Uint8Array): unknown {
    return decode(Buffer.from(bytes));
  },
};
