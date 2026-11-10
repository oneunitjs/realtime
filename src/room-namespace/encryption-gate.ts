/**
 * Encryption Gate — Encryption policy enforcement for rooms.
 *
 * Aligns with the E2EE Architecture. Rooms carry an encryptionPolicy:
 *
 * | Policy   | Behavior                                                            |
 * |----------|---------------------------------------------------------------------|
 * | disabled | Plaintext allowed; no key checks on join                            |
 * | optional | Mixed encrypted/plaintext allowed; per-message rules documented     |
 * | required | Membership blocked until key enrollment for current epoch succeeds  |
 *
 * Required-encryption rules:
 *   - Unkeyed clients are rejected at join (or blocked from publish)
 *   - On device removal or key revocation: advance room key epoch and rekey
 *   - Stale epochs are rejected
 *   - In server-blind E2EE: Hub routes ciphertext only, never derives
 *     group plaintext keys
 *
 * Never admit a member into a `required` room and then "skip" them on
 * encrypted broadcast — that creates silent message loss and false
 * security assumptions.
 */

import type {
  EncryptionPolicy,
  RoomError,
  RoomErrorCode,
} from "./types.js";

// ---------------------------------------------------------------------------
// Encryption Gate
// ---------------------------------------------------------------------------

/**
 * Result of an encryption policy check.
 */
export interface EncryptionGateResult {
  allowed: boolean;
  error?: RoomError;
}

/**
 * Encryption gate for room operations.
 */
export class EncryptionGate {
  // Track current key epoch per room
  private readonly roomEpochs = new Map<string, number>(); // roomKey -> epoch

  /**
   * Get the current key epoch for a room.
   */
  getEpoch(roomKey: string): number {
    return this.roomEpochs.get(roomKey) ?? 0;
  }

  /**
   * Advance the key epoch for a room (called on revocation/rekey).
   * All remaining members must rekey before future sends.
   */
  advanceEpoch(roomKey: string): number {
    const current = this.roomEpochs.get(roomKey) ?? 0;
    const next = current + 1;
    this.roomEpochs.set(roomKey, next);
    return next;
  }

  /**
   * Set the key epoch for a room.
   */
  setEpoch(roomKey: string, epoch: number): void {
    this.roomEpochs.set(roomKey, epoch);
  }

  /**
   * Check if a client can join a room given its encryption policy.
   *
   * For `required` policy: client must have a current-epoch key.
   * For `disabled`/`optional`: no key check at join.
   */
  async checkJoin(
    roomKey: string,
    policy: EncryptionPolicy,
    hasCurrentKey: boolean,
  ): Promise<EncryptionGateResult> {
    if (policy === "required" && !hasCurrentKey) {
      return {
        allowed: false,
        error: {
          code: "ENCRYPTION_REQUIRED",
          message: `Room ${roomKey} requires encryption; client must enroll a current-epoch key`,
          roomKey,
        },
      };
    }

    return { allowed: true };
  }

  /**
   * Check if a publish is allowed given encryption policy.
   *
   * For `required` policy: payload must be a valid ciphertext envelope
   * for the current epoch; plaintext is rejected.
   * For `disabled`: plaintext allowed.
   * For `optional`: both allowed (per-message rules documented elsewhere).
   */
  async checkPublish(
    roomKey: string,
    policy: EncryptionPolicy,
    payload: unknown,
    hasCurrentKey: boolean,
  ): Promise<EncryptionGateResult> {
    if (policy === "required") {
      // Reject plaintext — must be a valid ciphertext envelope
      if (!this.isValidCiphertextEnvelope(payload)) {
        return {
          allowed: false,
          error: {
            code: "ENCRYPTION_REQUIRED",
            message: `Room ${roomKey} requires encrypted payloads; plaintext rejected`,
            roomKey,
          },
        };
      }

      // Must have current key
      if (!hasCurrentKey) {
        return {
          allowed: false,
          error: {
            code: "STALE_KEY_EPOCH",
            message: `Room ${roomKey} requires current-epoch key; stale key rejected`,
            roomKey,
          },
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Validate that a payload is a ciphertext envelope (not plaintext).
   *
   * A ciphertext envelope has shape: { type: "e2ee", ciphertext: string }
   */
  private isValidCiphertextEnvelope(payload: unknown): boolean {
    if (typeof payload !== "object" || payload === null) {
      return false;
    }

    const obj = payload as Record<string, unknown>;
    return (
      obj.type === "e2ee" &&
      typeof obj.ciphertext === "string" &&
      obj.ciphertext.length > 0
    );
  }

  /**
   * Create an error for stale key epoch rejection.
   */
  static staleEpochError(roomKey: string): RoomError {
    return {
      code: "STALE_KEY_EPOCH",
      message: `Room ${roomKey} requires current-epoch key; stale key rejected`,
      roomKey,
    };
  }

  /**
   * Create an error for encryption required rejection.
   */
  static encryptionRequiredError(roomKey: string): RoomError {
    return {
      code: "ENCRYPTION_REQUIRED",
      message: `Room ${roomKey} requires encryption; client must enroll a current-epoch key`,
      roomKey,
    };
  }

  /**
   * Create an error for plaintext rejected in required room.
   */
  static plaintextRejectedError(roomKey: string): RoomError {
    return {
      code: "ENCRYPTION_REQUIRED",
      message: `Room ${roomKey} requires encrypted payloads; plaintext rejected`,
      roomKey,
    };
  }
}
