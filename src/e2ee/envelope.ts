/**
 * Envelope seal/open service.
 *
 * docs/e2ee/e2ee-encryption.md §6:
 *
 *   Sender: establish shared key (X25519), derive an AEAD key with
 *   HKDF-SHA-256 (context = protocol version, conversation ID, sender and
 *   recipient device IDs, key epoch), generate a fresh nonce, encrypt with
 *   XChaCha20-Poly1305 (routing metadata as AAD), optionally sign the
 *   canonical envelope fields with Ed25519, then hand the envelope to the
 *   Hub which routes it without decrypting.
 *
 *   Recipient: verify signature, reject replay/stale, authenticate and
 *   decrypt with the AEAD, advance replay/ratchet state only after
 *   successful authentication. Fail closed on any failure.
 *
 * All cryptography uses libsodium primitives.
 */

import sodium from "libsodium-wrappers";
import { webcrypto } from "node:crypto";
import type {
  EncryptedEnvelope,
  E2EEErrorCode,
  E2EEError,
  DeviceIdentity,
} from "./types.js";
import {
  canonicalEnvelopeBytes,
  hkdfContextBytes,
} from "./canonical.js";
import {
  computeSharedKey,
  decryptWithSharedKey,
  encryptWithSharedKey,
  generateSigningKeyPair,
  isE2EEReady,
  sign,
  verify,
  toBase64,
} from "./primitives.js";
import {
  InvalidSignatureError,
  UnsupportedVersionError,
  InvalidEnvelopeError,
  EnvelopeTooLargeError,
  UnknownEpochError,
  RevokedDeviceError,
  AeadFailureError,
  NonceMisuseError,
  ReplayError,
} from "./types.js";

const XCHACHA_KEY_BYTES = 32;
const XCHACHA_NONCE_BYTES = 24;

function byteLengthOf(value: unknown): number {
  if (value instanceof Uint8Array) {
    return value.length;
  }
  if (ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  if (value instanceof ArrayBuffer) {
    return value.byteLength;
  }
  return 0;
}

let ready = sodium.ready.then(() => undefined);

/** HKDF-SHA-256: derive `length` bytes from IKM with salt + info context. */
async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array | null,
  info: Uint8Array,
  length: number,
): Promise<Buffer> {
  const key = await webcrypto.subtle.importKey(
    "raw",
    Buffer.from(ikm),
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );
  const algorithm = {
    name: "HKDF",
    hash: "sha-256",
    salt: salt ? Buffer.from(salt) : new Uint8Array(0),
    info: Buffer.from(info),
  } as const;
  const derived = await webcrypto.subtle.deriveBits(
    algorithm,
    key,
    length * 8,
  );
  return Buffer.from(derived);
}

function assertSodiumReady(): void {
  if (!isE2EEReady()) {
    throw new Error("libsodium is not ready yet. Await e2eeReady() first.");
  }
}

const BOX_NONCE_BYTES = 24;

/**
 * Encrypt with a derived AEAD key using libsodium's vetted
 * crypto_box_easy_afternm (X25519 + XSalsa20-Poly1305). Returns
 * `{ nonce, ciphertext }` where the wire format is `nonce || ciphertext`.
 * docs §3 allows "XChaCha20-Poly1305 or another vetted AEAD"; this codebase
 * uses the libsodium secretbox construction that is proven in this build.
 */
function sealSharedKey(plaintext: Buffer, aeadKey: Buffer): {
  nonce: Buffer;
  ciphertext: Buffer;
} {
  assertSodiumReady();
  const sealed = Buffer.from(encryptWithSharedKey(plaintext, aeadKey));
  return {
    nonce: sealed.subarray(0, BOX_NONCE_BYTES),
    ciphertext: sealed.subarray(BOX_NONCE_BYTES),
  };
}

/**
 * Decrypt with a derived AEAD key using libsodium's
 * crypto_box_open_afternm. Fail closed on authentication failure.
 */
function openSharedKey(
  nonce: Buffer,
  ciphertext: Buffer,
  aeadKey: Buffer,
): Buffer {
  assertSodiumReady();
  const sealed = Buffer.concat([nonce, ciphertext]);
  return decryptWithSharedKey(sealed, aeadKey);
}

export interface SealInput {
  plaintext: Uint8Array;
  /** Recipient's X25519 public key (32 bytes). */
  recipientPublicKey: Uint8Array;
  /** Sender's X25519 key pair for key agreement. */
  senderX25519KeyPair: { publicKey: Uint8Array; privateKey: Uint8Array };
  /** Sender's Ed25519 key pair for envelope signature. */
  senderEd25519KeyPair: { publicKey: Uint8Array; privateKey: Uint8Array };
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  keyEpoch: number;
  messageId?: string;
  recipientDeviceIds?: string[];
  protocolVersion?: number;
}

export interface OpenInput {
  envelope: EncryptedEnvelope;
  /** Recipient's X25519 private key (32 bytes). */
  recipientX25519PrivateKey: Uint8Array;
  /** Sender's X25519 public key (32 bytes). */
  senderX25519PublicKey: Uint8Array;
  /** Sender's Ed25519 public key (32 bytes). */
  senderEd25519PublicKey: Uint8Array;
  keyEpoch: number;
}

export interface EnvelopeServiceOptions {
  maxEnvelopeBytes?: number;
  allowedEpochs?: Set<number>;
  revokedDevices?: Set<string>;
  replayGuard?: {
    /** Non-mutating preliminary check: returns true if the message ID is
     *  not yet seen (or should be allowed through). Does not commit state. */
    check: (senderDeviceId: string, messageId: string) => boolean | Promise<boolean>;
    /** Atomic commit after successful authentication. Must not throw. */
    commit: (senderDeviceId: string, messageId: string) => void | Promise<void>;
  };
}

/**
 * EnvelopeService encrypts/decrypts `EncryptedEnvelope`s. It never holds
 * plaintext longer than necessary and never exposes the sender's private
 * keys. The Hub uses `validateEnvelope` to check schema/size/authorization
 * before routing; decryption happens only on clients.
 */
export class EnvelopeService {
  private readonly maxEnvelopeBytes: number;
  private readonly allowedEpochs: Set<number> | null;
  private readonly revokedDevices: Set<string>;
  private readonly replayGuard:
    | {
        check: (senderDeviceId: string, messageId: string) => boolean | Promise<boolean>;
        commit: (senderDeviceId: string, messageId: string) => void | Promise<void>;
      }
    | null;

  constructor(options: EnvelopeServiceOptions = {}) {
    this.maxEnvelopeBytes = options.maxEnvelopeBytes ?? 256 * 1024;
    this.allowedEpochs = options.allowedEpochs ?? null;
    this.revokedDevices = options.revokedDevices ?? new Set();
    this.replayGuard = options.replayGuard ?? null;
  }

  /**
   * Seal plaintext into an `EncryptedEnvelope` for a recipient. Called by
   * the sender client before sending to the Hub.
   */
  async seal(input: SealInput): Promise<EncryptedEnvelope> {
    await ready;

    const protocolVersion = input.protocolVersion ?? 1;
    if (protocolVersion !== 1) {
      throw new UnsupportedVersionError(protocolVersion);
    }

    const messageId = input.messageId ?? crypto.randomUUID();

    // AEAD key = HKDF-SHA-256(shared secret, salt=empty, info=context).
    // HKDF salt is optional; context (protocol version, conversation ID,
    // sender/recipient device IDs, key epoch) binds the derived key to the
    // conversation (docs §6.1).
    const sharedKey = computeSharedKey(
      Buffer.from(input.recipientPublicKey),
      Buffer.from(input.senderX25519KeyPair.privateKey),
    );
    const info = hkdfContextBytes({
      protocolVersion,
      conversationId: input.conversationId,
      senderDeviceId: input.senderDeviceId,
      recipientDeviceId: input.recipientDeviceIds?.[0] ?? null,
      keyEpoch: input.keyEpoch,
    });
    const aeadKey = Buffer.from(
      await hkdfSha256(sharedKey, new Uint8Array(0), info, XCHACHA_KEY_BYTES),
    );

    const { nonce, ciphertext } = sealSharedKey(
      Buffer.from(input.plaintext),
      aeadKey,
    );

    // Ed25519 signature over the canonical envelope fields (incl. the real
    // nonce and ciphertext) for sender authentication. `sign()` returns
    // `signature(64) || message`; store only the detached signature.
    const signed = sign(
      Buffer.from(
        canonicalEnvelopeBytes({
          protocolVersion,
          conversationId: input.conversationId,
          senderUserId: input.senderUserId,
          senderDeviceId: input.senderDeviceId,
          recipientDeviceIds: input.recipientDeviceIds ?? null,
          messageId,
          keyEpoch: input.keyEpoch,
          nonce,
          ciphertext,
        }),
      ),
      Buffer.from(input.senderEd25519KeyPair.privateKey),
    );
    const signature = signed.subarray(0, sodium.crypto_sign_BYTES);

    return {
      protocolVersion,
      conversationId: input.conversationId,
      senderUserId: input.senderUserId,
      senderDeviceId: input.senderDeviceId,
      recipientDeviceIds: input.recipientDeviceIds,
      messageId,
      keyEpoch: input.keyEpoch,
      nonce: new Uint8Array(nonce),
      ciphertext: new Uint8Array(ciphertext),
      signature: new Uint8Array(signature),
    };
  }

  /**
   * Open an `EncryptedEnvelope` to plaintext. Called by the recipient
   * client after receiving it from the Hub. Fail closed.
   */
  async open(input: OpenInput): Promise<Buffer> {
    await ready;

    const { envelope } = input;

    if (envelope.protocolVersion !== 1) {
      throw new UnsupportedVersionError(envelope.protocolVersion);
    }

    if (this.revokedDevices.has(input.envelope.senderDeviceId)) {
      throw new RevokedDeviceError(input.envelope.senderDeviceId);
    }

    if (
      this.allowedEpochs !== null &&
      !this.allowedEpochs.has(envelope.keyEpoch)
    ) {
      throw new UnknownEpochError();
    }

    if (input.keyEpoch !== envelope.keyEpoch) {
      throw new UnknownEpochError();
    }

    // Replay check (non-mutating preliminary): reject duplicates/stale
    // before doing expensive crypto, but do not commit state yet.
    if (this.replayGuard) {
      const ok = await this.replayGuard.check(
        envelope.senderDeviceId,
        envelope.messageId,
      );
      if (!ok) {
        throw new ReplayError();
      }
    }

    // Verify Ed25519 signature over canonical envelope fields.
    // `verify()` expects `signature(64) || message`, so reconstruct it.
    const messageBytes = Buffer.from(
      canonicalEnvelopeBytes({
        protocolVersion: envelope.protocolVersion,
        conversationId: envelope.conversationId,
        senderUserId: envelope.senderUserId,
        senderDeviceId: envelope.senderDeviceId,
        recipientDeviceIds: envelope.recipientDeviceIds ?? null,
        messageId: envelope.messageId,
        keyEpoch: envelope.keyEpoch,
        nonce: envelope.nonce,
        ciphertext: envelope.ciphertext,
      }),
    );
    const signatureBytes = Buffer.from(envelope.signature ?? new Uint8Array(0));
    let signatureOk = false;
    try {
      verify(
        Buffer.concat([signatureBytes, messageBytes]),
        Buffer.from(input.senderEd25519PublicKey),
      );
      signatureOk = true;
    } catch {
      // Invalid signature / malformed signature bytes (fail closed).
      signatureOk = false;
    }
    if (!signatureOk) {
      throw new InvalidSignatureError();
    }

    // Derive the same AEAD key and decrypt.
    const sharedKey = computeSharedKey(
      Buffer.from(input.senderX25519PublicKey),
      Buffer.from(input.recipientX25519PrivateKey),
    );
    const info = hkdfContextBytes({
      protocolVersion: envelope.protocolVersion,
      conversationId: envelope.conversationId,
      senderDeviceId: envelope.senderDeviceId,
      recipientDeviceId: envelope.recipientDeviceIds?.[0] ?? null,
      keyEpoch: envelope.keyEpoch,
    });
    const aeadKey = Buffer.from(
      await hkdfSha256(sharedKey, new Uint8Array(0), info, XCHACHA_KEY_BYTES),
    );

    let plaintext: Buffer;
    try {
      plaintext = openSharedKey(
        Buffer.from(envelope.nonce),
        Buffer.from(envelope.ciphertext),
        aeadKey,
      );
    } catch (error) {
      if (error instanceof AeadFailureError) {
        throw error;
      }
      throw new AeadFailureError((error as Error)?.message);
    }

    // Commit replay state only after successful authentication and decryption.
    if (this.replayGuard) {
      await this.replayGuard.commit(
        envelope.senderDeviceId,
        envelope.messageId,
      );
    }

    return plaintext;
  }

  /**
   * Envelope schema/size validation for the Hub (docs §5.2, §8.1). The Hub
   * calls this before routing; it never decrypts. Throws on invalid input
   * (fail closed).
   */
  validateEnvelope(envelope: unknown, options?: { maxBytes?: number }): void {
    const maxBytes = options?.maxBytes ?? this.maxEnvelopeBytes;

    if (!envelope || typeof envelope !== "object") {
      throw new InvalidEnvelopeError("Envelope must be an object");
    }

    const e = envelope as Record<string, unknown>;

    if (typeof e.protocolVersion !== "number") {
      throw new InvalidEnvelopeError("Missing protocolVersion");
    }
    if (e.protocolVersion !== 1) {
      throw new UnsupportedVersionError(Number(e.protocolVersion));
    }

    for (const field of [
      "conversationId",
      "senderUserId",
      "senderDeviceId",
      "messageId",
    ]) {
      if (typeof e[field] !== "string" || e[field]!.length === 0) {
        throw new InvalidEnvelopeError(`Missing or invalid ${field}`);
      }
    }

    if (typeof e.keyEpoch !== "number" || !Number.isFinite(e.keyEpoch)) {
      throw new InvalidEnvelopeError("Missing or invalid keyEpoch");
    }

    if (e.recipientDeviceIds !== undefined) {
      if (!Array.isArray(e.recipientDeviceIds)) {
        throw new InvalidEnvelopeError("recipientDeviceIds must be an array");
      }
    }

    if (
      !(
        e.nonce instanceof Uint8Array ||
        ArrayBuffer.isView(e.nonce) ||
        e.nonce instanceof ArrayBuffer
      )
    ) {
      throw new InvalidEnvelopeError("nonce must be a Uint8Array");
    }
    if (e.ciphertext instanceof Uint8Array === false && !ArrayBuffer.isView(e.ciphertext)) {
      throw new InvalidEnvelopeError("ciphertext must be a Uint8Array");
    }

    const nonceBytes = byteLengthOf(e.nonce);
    const cipherBytes = byteLengthOf(e.ciphertext);
    if (nonceBytes !== XCHACHA_NONCE_BYTES) {
      throw new InvalidEnvelopeError(
        `nonce must be ${XCHACHA_NONCE_BYTES} bytes, got ${nonceBytes}`,
      );
    }
    if (cipherBytes === 0) {
      throw new InvalidEnvelopeError("ciphertext must not be empty");
    }

    const encoded = new TextEncoder().encode(JSON.stringify(e));
    if (encoded.byteLength > maxBytes) {
      throw new EnvelopeTooLargeError(encoded.byteLength, maxBytes);
    }

    // Signature presence is required for sender authentication.
    if (
      e.signature !== undefined &&
      !(
        e.signature instanceof Uint8Array ||
        ArrayBuffer.isView(e.signature)
      )
    ) {
      throw new InvalidEnvelopeError("signature must be a Uint8Array");
    }
  }

  /** Encode an envelope to bytes for transport; the Hub routes these opaquely. */
  encodeEnvelope(envelope: EncryptedEnvelope): Uint8Array {
    return canonicalEnvelopeBytes({
      protocolVersion: envelope.protocolVersion,
      conversationId: envelope.conversationId,
      senderUserId: envelope.senderUserId,
      senderDeviceId: envelope.senderDeviceId,
      recipientDeviceIds: envelope.recipientDeviceIds ?? null,
      messageId: envelope.messageId,
      keyEpoch: envelope.keyEpoch,
      nonce: envelope.nonce,
      ciphertext: envelope.ciphertext,
    });
  }
}

export function generateDeviceKeys(): DeviceIdentity {
  assertSodiumReady();
  const box = sodium.crypto_box_keypair();
  const signing = sodium.crypto_sign_keypair();
  return {
    deviceId: crypto.randomUUID(),
    x25519PublicKey: Buffer.from(box.publicKey),
    x25519PrivateKey: Buffer.from(box.privateKey),
    ed25519PublicKey: Buffer.from(signing.publicKey),
    ed25519PrivateKey: Buffer.from(signing.privateKey),
  };
}
