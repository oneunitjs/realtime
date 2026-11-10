/**
 * Collaboration Engine server-side: operation broadcaster.
 *
 * Implements docs/collab/collaboration-engine-architecture-plan.md §9.3.
 *
 * Broadcasts committed operations to authorized document subscribers. The
 * broadcaster is transport-independent: it accepts a `send` callback per
 * recipient rather than depending on uWebSockets or any specific WebSocket
 * library.
 *
 * Fan-out follows commit: only operations that have been durably persisted
 * are broadcast, and only to subscribers of the same document scope.
 */

import type {
  CrdtOperation,
  ElementId,
} from "../core/types.js";
import type { DocumentScope } from "./document-key.js";
import type { DocumentSubscriptions } from "./subscriptions.js";

export interface BroadcastResult {
  accepted: number;
  buffered: number;
  dropped: number;
  failed: number;
  recipients: number;
}

/** Per-recipient send result. */
export interface SendOutcome {
  status: "accepted" | "buffered" | "dropped";
}

/** Sends an envelope to a single recipient. */
export type SendFn = (
  connectionId: string,
  envelope: unknown,
) => Promise<SendOutcome>;

export interface CollaborationBroadcaster {
  /**
   * Broadcast an operation to all subscribers of a document scope, excluding
   * the sender. Returns per-outcome counts.
   */
  broadcast(
    scope: DocumentScope,
    operation: CrdtOperation,
    options?: {
      excludeConnectionId?: string;
      send?: SendFn;
    },
  ): Promise<BroadcastResult>;
}

/** Outbox entry for crash-safe broadcast delivery. */
export interface OutboxEntry {
  id: string;
  scope: DocumentScope;
  operation: CrdtOperation;
  excludeConnectionId?: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

/** Stores and dispatches pending broadcast events. */
export interface OutboxStore {
  append(entry: OutboxEntry): Promise<void>;
  listPending(): Promise<OutboxEntry[]>;
  markSent(id: string): Promise<void>;
  markFailed(id: string): Promise<void>;
}

/**
 * In-memory broadcaster with an optional outbox for crash-safe delivery.
 *
 * Without an outbox, broadcast is best-effort: a server crash after commit
 * but before fan-out means collaborators miss the update until they
 * resynchronize. With an outbox, pending broadcasts survive a crash and are
 * retried by a background dispatcher.
 */
export class MemoryBroadcaster implements CollaborationBroadcaster {
  private readonly subscriptions: DocumentSubscriptions;
  private readonly send: SendFn;
  private readonly outbox?: OutboxStore;

  constructor(
    subscriptions: DocumentSubscriptions,
    send: SendFn,
    outbox?: OutboxStore,
  ) {
    this.subscriptions = subscriptions;
    this.send = send;
    this.outbox = outbox;
  }

  async broadcast(
    scope: DocumentScope,
    operation: CrdtOperation,
    options: {
      excludeConnectionId?: string;
      send?: SendFn;
    } = {},
  ): Promise<BroadcastResult> {
    const send = options.send ?? this.send;
    const excludeConnectionId = options.excludeConnectionId;
    const members = this.subscriptions.members(scope);

    const result: BroadcastResult = {
      accepted: 0,
      buffered: 0,
      dropped: 0,
      failed: 0,
      recipients: members.length,
    };

    // Record in the outbox first (crash-safe) when configured.
    if (this.outbox) {
      await this.outbox.append({
        id: crypto.randomUUID(),
        scope,
        operation,
        excludeConnectionId,
        status: "pending",
        attempts: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    for (const connectionId of members) {
      if (connectionId === excludeConnectionId) {
        continue;
      }

      try {
        const envelope = {
          type: "operation",
          scope,
          operation,
          head: undefined, // filled in by caller if desired
        };

        const outcome = await send(connectionId, envelope);

        switch (outcome.status) {
          case "accepted":
            result.accepted += 1;
            break;
          case "buffered":
            result.buffered += 1;
            break;
          case "dropped":
            result.dropped += 1;
            // Dropped frames should trigger client resynchronization via
            // the client's last acknowledged vector clock.
            break;
        }
      } catch {
        result.failed += 1;
      }
    }

    if (this.outbox) {
      await this.outbox.markSent(crypto.randomUUID());
    }

    return result;
  }

  /**
   * Retry all pending outbox entries. Intended to be invoked by a background
   * dispatcher after a restart so that broadcasts that were committed but
   * not yet delivered are retried.
   */
  async retryPending(): Promise<void> {
    if (!this.outbox) {
      return;
    }

    const pending = await this.outbox.listPending();

    for (const entry of pending) {
      try {
        const members = this.subscriptions.members(entry.scope);

        for (const connectionId of members) {
          if (connectionId === entry.excludeConnectionId) {
            continue;
          }

          const outcome = await this.send(connectionId, {
            type: "operation",
            scope: entry.scope,
            operation: entry.operation,
            head: undefined,
          });

          if (outcome.status === "accepted") {
            // Continue to next recipient.
          }
        }

        await this.outbox.markSent(entry.id);
      } catch {
        await this.outbox.markFailed(entry.id);
      }
    }
  }
}
