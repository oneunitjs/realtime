/**
 * ACK handling.
 *
 * Validates and applies `DeliveryAck`s:
 *
 *   - Authenticate the ACK against the actual connection that sends it.
 *   - Verify the connection is the intended recipient for that delivery
 *     record.
 *   - Reject ACKs from a different connection without mutating the real
 *     recipient's state.
 *   - Repeated ACKs are idempotent (no-ops on terminal states).
 *   - A late ACK after a retry completes the same record identified by
 *     (messageId, recipientConnectionId).
 */

import type { DeliveryAck, DeliveryRecord, DeliveryState } from "./types.js";
import {
  canTransition,
  deliveryRecordKey,
  transitionName,
} from "./delivery-state.js";
import type { DeliveryRecordStore } from "./delivery-state.js";

export type AckResult = {
  ok: true;
  state: DeliveryState;
  transitioned: boolean;
} | {
  ok: false;
  reason: string;
  code: "UNKNOWN_MESSAGE" | "WRONG_RECIPIENT" | "INVALID_ACK" | "TERMINAL";
};

/**
 * ACK handler. `isSender` authenticates that `connectionId` is the sender
 * of the ACK (bound to the actual connection, not a payload claim).
 */
export class AckHandler {
  constructor(
    private readonly store: DeliveryRecordStore,
    private readonly isSender: (connectionId: string, claimingConnectionId: string) => boolean,
  ) {}

  /**
   * Apply an ACK. Returns the resulting state and whether a transition
   * occurred. Duplicate ACKs on `received`/`processed` are no-ops.
   */
  handle(
    ack: DeliveryAck,
    sendingConnectionId: string,
  ): AckResult {
    // Authenticate: the sending connection must be the one claiming to send
    // the ACK (bound to actual connection, not a payload claim).
    if (!this.isSender(sendingConnectionId, ack.recipientConnectionId)) {
      return {
        ok: false,
        reason: "ACK from wrong connection",
        code: "WRONG_RECIPIENT",
      };
    }

    const key = deliveryRecordKey(ack.messageId, ack.recipientConnectionId);
    const record = this.store.get(key);
    if (!record) {
      return {
        ok: false,
        reason: `No delivery record for message ${ack.messageId} and recipient ${ack.recipientConnectionId}`,
        code: "UNKNOWN_MESSAGE",
      };
    }

    const targetState = ack.kind === "processed" ? "processed" : "received";

    // Idempotent: if already at or beyond the target state, no-op.
    const ordinal = stateOrdinal(record.state);
    const targetOrdinal = stateOrdinal(targetState);
    if (ordinal >= targetOrdinal) {
      return { ok: true, state: record.state, transitioned: false };
    }

    // Legal transition check: received→processed, written→received, etc.
    if (!canTransition(record.state, targetState)) {
      return {
        ok: false,
        reason: `Illegal transition ${record.state} → ${targetState}`,
        code: "INVALID_ACK",
      };
    }

    const next: DeliveryRecord = {
      ...record,
      state: targetState,
      attempts: record.attempts + 1,
    };
    this.store.set(next);

    return { ok: true, state: targetState, transitioned: true };
  }
}

/** Numeric ordering of delivery states for idempotency checks. */
function stateOrdinal(state: DeliveryState): number {
  const order: Record<DeliveryState, number> = {
    created: 0,
    accepted: 1,
    queued: 2,
    written: 3,
    received: 4,
    processed: 5,
    failed: -1,
    expired: -1,
  };
  return order[state];
}
