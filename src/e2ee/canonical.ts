/**
 * Canonical serialization for E2EE signatures and HKDF context.
 *
 * docs/e2ee/e2ee-encryption.md §5.1: signatures must cover a canonical
 * encoding — never arbitrary JSON serialization, since key order and
 * whitespace differences break verification. Fields are serialized in a
 * fixed order using notepack (MessagePack), which is deterministic when the
 * input structure is constructed in a fixed order.
 */

import { encode, decode } from "notepack.io";

/** Canonical byte encoding of the signed envelope fields. */
export function canonicalEnvelopeBytes(fields: {
  protocolVersion: number;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  recipientDeviceIds?: string[] | null;
  messageId: string;
  keyEpoch: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}): Uint8Array {
  return encode([
    fields.protocolVersion,
    fields.conversationId,
    fields.senderUserId,
    fields.senderDeviceId,
    fields.recipientDeviceIds ?? null,
    fields.messageId,
    fields.keyEpoch,
    Buffer.from(fields.nonce),
    Buffer.from(fields.ciphertext),
  ]);
}

/** Canonical byte encoding of HKDF context (docs §6.1). */
export function hkdfContextBytes(fields: {
  protocolVersion: number;
  conversationId: string;
  senderDeviceId: string;
  recipientDeviceId?: string | null;
  keyEpoch: number;
}): Uint8Array {
  return encode([
    fields.protocolVersion,
    fields.conversationId,
    fields.senderDeviceId,
    fields.recipientDeviceId ?? null,
    fields.keyEpoch,
  ]);
}

/**
 * Canonical byte encoding of a signed device record. The public keys ARE
 * included so that key-substitution is detectable by signature verification.
 */
export function canonicalDeviceRecordBytes(fields: {
  deviceId: string;
  accountId: string;
  x25519PublicKey: Uint8Array;
  ed25519PublicKey: Uint8Array;
}): Uint8Array {
  return encode([
    fields.deviceId,
    fields.accountId,
    Buffer.from(fields.x25519PublicKey),
    Buffer.from(fields.ed25519PublicKey),
  ]);
}

/** Round-trip a canonical envelope byte string back into a field record. */
export function parseCanonicalEnvelopeBytes(
  bytes: Uint8Array,
): {
  protocolVersion: number;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  recipientDeviceIds: string[] | null;
  messageId: string;
  keyEpoch: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
} {
  const [a, b, c, d, e, f, g, h, i] = decode(Buffer.from(bytes)) as unknown[];
  return {
    protocolVersion: Number(a),
    conversationId: String(b),
    senderUserId: String(c),
    senderDeviceId: String(d),
    recipientDeviceIds: Array.isArray(e) ? (e as string[]) : null,
    messageId: String(f),
    keyEpoch: Number(g),
    nonce: Buffer.from(h as Uint8Array),
    ciphertext: Buffer.from(i as Uint8Array),
  };
}
