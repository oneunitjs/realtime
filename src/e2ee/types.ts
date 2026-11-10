/**
 * End-to-End Encryption types.
 *
 * Implements the contract in docs/e2ee/e2ee-encryption.md and
 * docs/e2ee/e2ee-architecture-plan.md:
 *
 * - Client-side encryption with authenticated public-key distribution.
 * - The Core Hub routes opaque `EncryptedEnvelope`s and never decrypts them.
 * - Envelope schema, size, and authorization are validated by the Hub;
 *   plaintext/CKDT content is never inspected server-side.
 *
* All cryptography uses libsodium primitives (X25519, HKDF-SHA-256,
* XSalsa20-Poly1305, Ed25519) via the existing `src/security/e2ee` layer.
 */

// ---------------------------------------------------------------------------
// Envelope contract (docs/e2ee/e2ee-encryption.md §5)
// ---------------------------------------------------------------------------

/**
 * Wire format of an end-to-end encrypted frame. The Hub may inspect and
 * validate the envelope; it must not need or see the plaintext.
 */
export interface EncryptedEnvelope {
  protocolVersion: number;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  recipientDeviceIds?: string[];
  messageId: string;
  keyEpoch: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  signature?: Uint8Array;
}

/** Current envelope protocol version. Reject anything else (fail closed). */
import { PROTOCOL_VERSION } from "../protocol/types.js";

export const E2EE_PROTOCOL_VERSION = PROTOCOL_VERSION;

/** Maximum encoded envelope size the Hub will accept. */
export const E2EE_MAX_ENVELOPE_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Device identity & trust (docs/e2ee/e2ee-architecture-plan.md §5.1, §5.2)
// ---------------------------------------------------------------------------

export interface DeviceIdentity {
  deviceId: string;
  x25519PublicKey: Uint8Array;
  x25519PrivateKey: Uint8Array;
  ed25519PublicKey: Uint8Array;
  ed25519PrivateKey: Uint8Array;
}

export interface SignedDeviceRecord {
  deviceId: string;
  x25519PublicKey: string; // base64
  ed25519PublicKey: string; // base64
  accountId: string;
  signature: string; // base64 over canonical record
}

export type TrustState = "trusted" | "pending" | "revoked" | "unknown";

export type TrustResult = {
  deviceId: string;
  trust: TrustState;
  reason?: string;
};

export interface DeviceIdentityManager {
  initialize(): Promise<DeviceIdentity>;
  getPublicDeviceRecord(): Promise<SignedDeviceRecord>;
  verifyDeviceRecord(record: SignedDeviceRecord): Promise<TrustResult>;
  approveDevice(deviceId: string, proof?: unknown): Promise<void>;
  revokeDevice(deviceId: string): Promise<void>;
  getTrustState(deviceId: string): Promise<TrustState>;
}

/**
 * Public-key directory contract. The Hub may store/distribute records, but
 * clients must verify signatures and trust state before use.
 */
export interface KeyDirectory {
  publishRecord(record: SignedDeviceRecord): Promise<void>;
  fetchRecord(accountId: string, deviceId: string): Promise<SignedDeviceRecord | null>;
  fetchAccountRecords(accountId: string): Promise<SignedDeviceRecord[]>;
  revokeRecord(accountId: string, deviceId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Envelope validation errors (fail closed)
// ---------------------------------------------------------------------------

export type E2EEErrorCode =
  | "E2EE_ERROR"
  | "E2EE_UNSUPPORTED_VERSION"
  | "E2EE_INVALID_ENVELOPE"
  | "E2EE_ENVELOPE_TOO_LARGE"
  | "E2EE_INVALID_SIGNATURE"
  | "E2EE_UNKNOWN_EPOCH"
  | "E2EE_REVOKED_DEVICE"
  | "E2EE_AEAD_FAILURE"
  | "E2EE_NONCE_MISUSE"
  | "E2EE_REPLAY"
  | "E2EE_KEY_NOT_FOUND";

export class E2EEError extends Error {
  readonly code: E2EEErrorCode;
  constructor(code: E2EEErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
    this.code = code;
  }
}

export class UnsupportedVersionError extends E2EEError {
  constructor(version: number) {
    super(
      "E2EE_UNSUPPORTED_VERSION",
      `Unsupported E2EE protocol version: ${version}`,
    );
  }
}

export class InvalidEnvelopeError extends E2EEError {
  constructor(message: string) {
    super("E2EE_INVALID_ENVELOPE", message);
  }
}

export class EnvelopeTooLargeError extends E2EEError {
  constructor(size: number, limit: number) {
    super(
      "E2EE_ENVELOPE_TOO_LARGE",
      `Envelope of ${size} bytes exceeds the ${limit} byte limit`,
    );
  }
}

export class InvalidSignatureError extends E2EEError {
  constructor(message = "Invalid E2EE envelope signature") {
    super("E2EE_INVALID_SIGNATURE", message);
  }
}

export class UnknownEpochError extends E2EEError {
  constructor(message = "Unknown or revoked E2EE key epoch") {
    super("E2EE_UNKNOWN_EPOCH", message);
  }
}

export class RevokedDeviceError extends E2EEError {
  constructor(deviceId?: string) {
    super(
      "E2EE_REVOKED_DEVICE",
      deviceId ? `Revoked E2EE device: ${deviceId}` : "Revoked E2EE device",
    );
  }
}

export class AeadFailureError extends E2EEError {
  constructor(message = "E2EE AEAD authentication failure") {
    super("E2EE_AEAD_FAILURE", message);
  }
}

export class NonceMisuseError extends E2EEError {
  constructor(message = "E2EE nonce reuse detected") {
    super("E2EE_NONCE_MISUSE", message);
  }
}

export class ReplayError extends E2EEError {
  constructor(message = "E2EE replay or stale message rejected") {
    super("E2EE_REPLAY", message);
  }
}

export class KeyNotFoundError extends E2EEError {
  constructor(deviceId: string) {
    super("E2EE_KEY_NOT_FOUND", `No key found for device: ${deviceId}`);
  }
}

// ---------------------------------------------------------------------------
// Replay protection (docs/e2ee/e2ee-encryption.md §7.1)
// ---------------------------------------------------------------------------

/**
 * Client-side replay guard. Tracks accepted message IDs per sender and
 * rejects duplicates. docs/e2ee/e2ee-encryption.md §7.1: message IDs help
 * deduplication; a bounded out-of-order counter window is a client policy
 * layered on top. State is advanced only after successful authentication.
 */
export class ReplayGuard {
  private readonly seenMessageIds = new Set<string>();

  /**
   * Record an accepted message. Returns false if it is a duplicate.
   * Callers treat `false` as reject (fail closed).
   */
  accept(senderDeviceId: string, messageId: string): boolean {
    const key = `${senderDeviceId}:${messageId}`;
    if (this.seenMessageIds.has(key)) {
      return false; // duplicate
    }
    this.seenMessageIds.add(key);
    return true;
  }
}
