/**
 * Delivery record state machine.
 *
 * Legal transitions:
 *
 *   created → accepted → queued → written → received → processed
 *                          ↘       ↘         ↘
 *                        failed   failed    failed
 *                          ↘
 *                        expired
 *
 * Rules (docs/event/event-management.md §5.2):
 *   - `written` is not proof of receipt.
 *   - `received` is not proof of application processing.
 *   - duplicate ACKs are no-ops.
 *   - late ACKs after retries update the original recipient record.
 *   - expired or failed records do not restart retry processing.
 *   - State transitions never regress.
 */

import type { DeliveryRecord, DeliveryState } from "./types.js";

export type DeliveryTransition =
  | { kind: "accept" }
  | { kind: "queue" }
  | { kind: "write" }
  | { kind: "receive" }
  | { kind: "process" }
  | { kind: "fail" }
  | { kind: "expire" };

// Source state → set of legal target states.
const TRANSITIONS: Record<DeliveryState, ReadonlySet<DeliveryState>> = {
  created: new Set(["accepted"]),
  accepted: new Set(["queued", "failed", "expired"]),
  queued: new Set(["written", "failed", "expired"]),
  written: new Set(["received", "failed", "expired"]),
  received: new Set(["processed", "failed", "expired"]),
  processed: new Set(),
  failed: new Set(),
  expired: new Set(),
};

export function canTransition(from: DeliveryState, to: DeliveryState): boolean {
  return TRANSITIONS[from]?.has(to) ?? false;
}

export function transitionName(from: DeliveryState, to: DeliveryState): DeliveryTransition["kind"] {
  switch (to) {
    case "accepted":
      return "accept";
    case "queued":
      return "queue";
    case "written":
      return "write";
    case "received":
      return "receive";
    case "processed":
      return "process";
    case "failed":
      return "fail";
    case "expired":
      return "expire";
    default:
      throw new Error(`No transition name for ${from} → ${to}`);
  }
}

// ---------------------------------------------------------------------------
// In-memory delivery record store
// ---------------------------------------------------------------------------

/**
 * In-memory delivery record store. Persistent implementations should
 * implement the same interface backed by a database (docs §10).
 *
 * Keyed by `${messageId}:${recipientConnectionId}` so late ACKs after a
 * retry update the original record.
 */
export interface DeliveryRecordStore {
  get(key: string): DeliveryRecord | undefined;
  set(record: DeliveryRecord): void;
  delete(key: string): boolean;
  keys(): string[];
  values(): DeliveryRecord[];
  size(): number;
}

export class MemoryDeliveryRecordStore implements DeliveryRecordStore {
  private readonly records = new Map<string, DeliveryRecord>();

  get(key: string): DeliveryRecord | undefined {
    return this.records.get(key);
  }

  set(record: DeliveryRecord): void {
    this.records.set(`${record.messageId}:${record.recipientConnectionId}`, record);
  }

  delete(key: string): boolean {
    return this.records.delete(key);
  }

  keys(): string[] {
    return [...this.records.keys()];
  }

  values(): DeliveryRecord[] {
    return [...this.records.values()];
  }

  size(): number {
    return this.records.size;
  }
}

export function deliveryRecordKey(messageId: string, recipientConnectionId: string): string {
  return `${messageId}:${recipientConnectionId}`;
}
