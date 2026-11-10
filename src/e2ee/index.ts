/**
 * End-to-End Encryption public surface.
 *
 * Implements docs/e2ee/e2ee-encryption.md and
 * docs/e2ee/e2ee-architecture-plan.md:
 *
 * - `EncryptedEnvelope` contract and canonical serialization
 * - `EnvelopeService` seal/open (X25519 + HKDF-SHA-256 + XChaCha20-Poly1305 +
 *   Ed25519), fail-closed
 * - `DeviceIdentityManager` / `KeyDirectory` contracts + in-memory references
 * - `ReplayGuard` for replay protection
 * - Core Hub envelope routing that never decrypts
 *
 * All cryptography uses libsodium. Independent cryptographic review is
 * required before production "E2EE" claims (docs §12.2).
 */

export type {
  EncryptedEnvelope,
  DeviceIdentity,
  SignedDeviceRecord,
  TrustState,
  TrustResult,
  DeviceIdentityManager,
  KeyDirectory,
  E2EEErrorCode,
} from "./types.js";

export {
  E2EE_PROTOCOL_VERSION,
  E2EE_MAX_ENVELOPE_BYTES,
  E2EEError,
  UnsupportedVersionError,
  InvalidEnvelopeError,
  EnvelopeTooLargeError,
  InvalidSignatureError,
  UnknownEpochError,
  RevokedDeviceError,
  AeadFailureError,
  NonceMisuseError,
  ReplayError,
  KeyNotFoundError,
  ReplayGuard,
} from "./types.js";

export type {
  SealInput,
  OpenInput,
  EnvelopeServiceOptions,
} from "./envelope.js";

export {
  EnvelopeService,
  generateDeviceKeys,
} from "./envelope.js";

export {
  canonicalEnvelopeBytes,
  hkdfContextBytes,
} from "./canonical.js";

export {
  MemoryDeviceIdentityManager,
} from "./device-identity.js";

export {
  MemoryKeyDirectory,
} from "./key-directory.js";

// Re-exported libsodium building blocks for consumers that need direct
// access (e.g. device identity managers).
export {
  generateKeyPair,
  generateSigningKeyPair,
  computeSharedKey,
  sign,
  verify,
  toBase64,
  fromBase64,
  isE2EEReady,
  e2eeReady,
} from "./primitives.js";
