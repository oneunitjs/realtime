/**
 * Event Service — validated, authorized event publishing with optional
 * per-recipient delivery tracking.
 *
 * Implements docs/event/event-management.md and
 * docs/event/event-management-delivery-architecture-plan.md.
 *
 * The service is a layer on top of Core Hub: it uses Hub for authenticated
 * connections, principals, room membership, authorization, and transport
 * routing. It never decrypts E2EE payloads; the payload is routed as opaque
 * bytes (docs §10).
 *
 * Delivery semantics:
 *   - `ephemeral`: best-effort, no retry, droppable under backpressure.
 *   - `at-least-once`: retry with stable `messageId`, bounded budget,
 *     expiry, duplicates possible.
 */

import type {
  DeliveryMode,
  DeliveryRecord,
  EventConfig,
  EventEnvelope,
  HubConnectionView,
  HubMembershipAccess,
  HubAuthorize,
  PublishOptions,
  PublishResult,
} from "./types.js";
import { DEFAULT_EVENT_CONFIG, EVENT_PROTOCOL_VERSION } from "./types.js";
import { EnvelopeBuilder } from "./envelope.js";
import { FanoutScheduler } from "./fanout.js";
import type { FanoutRecipient } from "./fanout.js";
import { AckHandler } from "./ack.js";
import { MemoryDeliveryRecordStore, deliveryRecordKey } from "./delivery-state.js";
import type { DeliveryRecordStore } from "./delivery-state.js";
import { globalRegistry, mapError } from "../error/index.js";
import type { ErrorRegistry } from "../error/index.js";

// ---------------------------------------------------------------------------
// Idempotency store: publisher + idempotencyKey → messageId + last result
// ---------------------------------------------------------------------------

interface IdempotencyEntry {
  messageId: string;
  result: PublishResult;
}

interface IdempotencyStore {
  get(
    publisherConnectionId: string,
    idempotencyKey: string,
  ): IdempotencyEntry | undefined;
  set(
    publisherConnectionId: string,
    idempotencyKey: string,
    entry: IdempotencyEntry,
  ): void;
}

class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();
  get(
    publisherConnectionId: string,
    idempotencyKey: string,
  ): IdempotencyEntry | undefined {
    return this.entries.get(`${publisherConnectionId}:${idempotencyKey}`);
  }
  set(
    publisherConnectionId: string,
    idempotencyKey: string,
    entry: IdempotencyEntry,
  ): void {
    this.entries.set(`${publisherConnectionId}:${idempotencyKey}`, entry);
  }
}

// ---------------------------------------------------------------------------
// Event Service
// ---------------------------------------------------------------------------

export interface EventServiceDeps {
  /** Core Hub (authenticated connections, principals, transport views). */
  hub: {
    getConnection(connectionId: string): HubConnectionView | undefined;
  };
  /** Room membership + authorization access from Core Hub. */
  membership: HubMembershipAccess;
  /** Authorization hook from Core Hub. */
  authorize?: HubAuthorize;
  /** Optional delivery record store (in-memory by default). */
  deliveryStore?: DeliveryRecordStore;
  /** Optional idempotency store (in-memory by default). */
  idempotencyStore?: IdempotencyStore;
  /** Optional fan-out scheduler (bounded by default). */
  fanout?: FanoutScheduler;
  /** Clock + id generator. */
  clock: { now(): number };
  idGenerator: { generate(): string };
  /** Error registry for mapping failures to public codes. */
  errorRegistry?: ErrorRegistry;
  config?: Partial<EventConfig>;
}

export class EventService {
  private readonly config: Readonly<EventConfig>;
  private readonly clock: { now(): number };
  private readonly hub: EventServiceDeps["hub"];
  private readonly membership: HubMembershipAccess;
  private readonly authorize?: HubAuthorize;
  private readonly store: DeliveryRecordStore;
  private readonly idempotencyStore: IdempotencyStore;
  private readonly fanout: FanoutScheduler;
  private readonly envelope: EnvelopeBuilder;
  private readonly ackHandler: AckHandler;
  private readonly errorRegistry: ErrorRegistry;

  constructor(deps: EventServiceDeps) {
    this.config = Object.freeze({
      ...DEFAULT_EVENT_CONFIG,
      ...deps.config,
    }) as Readonly<EventConfig>;

    this.clock = deps.clock;
    this.hub = deps.hub;
    this.membership = deps.membership;
    this.authorize = deps.authorize;
    this.store = deps.deliveryStore ?? new MemoryDeliveryRecordStore();
    this.idempotencyStore = deps.idempotencyStore ?? new MemoryIdempotencyStore();
    this.fanout =
      deps.fanout ??
      new FanoutScheduler({
        concurrency: this.config.maxFanoutConcurrency,
        maxQueuedBytesPerConnection: this.config.maxQueuedBytesPerConnection,
      });
    this.envelope = new EnvelopeBuilder(deps.clock, deps.idGenerator, {
      protocolVersion: this.config.protocolVersion ?? EVENT_PROTOCOL_VERSION,
      maxPayloadBytes:
        (this.config.maxPayloadBytes ?? DEFAULT_EVENT_CONFIG.maxPayloadBytes) as number,
    });
    this.ackHandler = new AckHandler(
      this.store,
      (connectionId, claimingConnectionId) =>
        connectionId === claimingConnectionId,
    );
    this.errorRegistry = deps.errorRegistry ?? globalRegistry;
  }

  // ------------------------------------------------------------------ publish

  /**
   * Publish an event to authorized recipients. Returns aggregate
   * accepted/failed/pending counts with a stable messageId.
   *
   * Steps:
   *   1. Verify publisher connection is authenticated.
   *   2. Normalize options; apply idempotency-key lookup.
   *   3. Build + validate envelope (protocol, size, expiry).
   *   4. Authorize the event against the authenticated principal.
   *   5. Resolve authorized recipient snapshot.
   *   6. Create delivery records (when tracking enabled).
   *   7. Dispatch with bounded fan-out + per-client queues.
   *   8. Return accepted/failed/pending.
   */
  async publish(
    connectionId: string,
    event: string,
    payload: unknown,
    options: PublishOptions = {},
  ): Promise<PublishResult> {
    // 1. Verify publisher exists and is authenticated.
    const publisher = this.hub.getConnection(connectionId);
    if (!publisher) {
      throw this.toPublicError(
        new Error(`Unknown connection: ${connectionId}`),
        "UNAUTHENTICATED",
        { retryable: false },
      );
    }
    if (!publisher.principal) {
      throw this.toPublicError(
        new Error("Connection is not authenticated"),
        "UNAUTHENTICATED",
        { retryable: false },
      );
    }
    const principal = publisher.principal;

    // 2. Normalize options; idempotency-key lookup for duplicate publish.
    const delivery: DeliveryMode = options.delivery ?? "ephemeral";
    if (options.idempotencyKey) {
      const existing = this.idempotencyStore.get(
        connectionId,
        options.idempotencyKey,
      );
      if (existing) {
        return existing.result; // same logical message, stable result
      }
    }

    // 3. Build + validate envelope.
    const now = this.clock.now();
    const expiresAt = options.timeoutMs ? now + options.timeoutMs : undefined;
    let envelope: EventEnvelope;
    try {
      const built = this.envelope.build({
        event,
        payload,
        namespace: principal.tenantId,
        roomId: undefined,
        senderConnectionId: connectionId,
        senderUserId: principal.userId,
        delivery,
        expiresAt,
      });
      envelope = built.envelope;
    } catch (error) {
      throw this.toPublicError(error, "VALIDATION_FAILED", {
        retryable: false,
        details: (error as Error)?.message,
      });
    }

    // 4. Authorize the event.
    const authorized = await this.authorizeEvent(
      principal,
      event,
      envelope.roomId,
      principal.tenantId,
      delivery,
    );
    if (!authorized) {
      throw this.toPublicError(
        new Error(`Not authorized to publish ${event}`),
        "FORBIDDEN",
        { retryable: false },
      );
    }

    // 5. Resolve authorized recipient snapshot (membership, excludeSender).
    // When no explicit room is targeted, broadcast to the namespace (tenant)
    // members — the docs' "namespace members" recipient set.
    const recipientIds = this.resolveRecipients(
      connectionId,
      envelope.roomId ?? principal.tenantId,
      options.excludeSender ?? true,
    );

    // 6. Create delivery records when tracking enabled.
    const deadlineAt = now + (expiresAt ?? this.config.defaultTtlMs ?? 300_000);
    for (const recipientId of recipientIds) {
      const record: DeliveryRecord = {
        messageId: envelope.messageId,
        recipientConnectionId: recipientId,
        state: "accepted",
        attempts: 0,
        deadlineAt,
      };
      this.store.set(record);
    }

    // 7. Dispatch with bounded fan-out + per-client queues.
    const encoded = this.encodeEnvelope(envelope);
    const recipients: FanoutRecipient[] = recipientIds.map((recipientId) => {
      const recipient = this.hub.getConnection(recipientId);
      return {
        connectionId: recipientId,
        send: async (data: Uint8Array) => {
          const live = this.hub.getConnection(recipientId) ?? recipient;
          if (!live?.transport) {
            throw new Error(`Recipient ${recipientId} not connected`);
          }
          await live.transport.send(data);
        },
      };
    });

    let accepted = 0;
    let failed = 0;
    let pending = 0;

    const results = await Promise.all(
      recipients.map(async (r) => {
        const ok = await this.fanout.enqueue(r, encoded);
        return { recipient: r, ok };
      }),
    );

    for (const { recipient, ok } of results) {
      const key = deliveryRecordKey(envelope.messageId, recipient.connectionId);
      const record = this.store.get(key);
      if (ok) {
        accepted += 1;
        if (record) {
          this.store.set({
            ...record,
            state: "written",
            attempts: record.attempts + 1,
          });
        }
        if (delivery === "at-least-once") {
          pending += 1; // awaiting received/processed ACK
        }
      } else {
        failed += 1;
        if (record) {
          this.store.set({
            ...record,
            state: "failed",
            attempts: record.attempts + 1,
          });
        }
      }
    }

    // 8. Record idempotency result.
    if (options.idempotencyKey) {
      this.idempotencyStore.set(connectionId, options.idempotencyKey, {
        messageId: envelope.messageId,
        result: {
          messageId: envelope.messageId,
          accepted,
          failed,
          pending,
        },
      });
    }

    return { messageId: envelope.messageId, accepted, failed, pending };
  }

  // ------------------------------------------------------------------ ACK

  /**
   * Apply a delivery ACK from a recipient connection. Authenticated and
   * connection-bound; idempotent; late ACKs complete the same record.
   */
  ack(
    ack: {
      messageId: string;
      recipientConnectionId: string;
      kind: "received" | "processed";
    },
    sendingConnectionId: string,
  ): { ok: boolean; state?: string; transitioned?: boolean; reason?: string; code?: string } {
    const result = this.ackHandler.handle(ack, sendingConnectionId);
    if (!result.ok) {
      return { ok: false, reason: result.reason, code: result.code };
    }
    return { ok: true, state: result.state, transitioned: result.transitioned };
  }

  // ------------------------------------------------------------------ expiry

  /** Expire records whose deadline has passed and are not yet terminal. */
  expire(): { expired: number } {
    let expired = 0;
    const now = this.clock.now();

    for (const record of this.store.values()) {
      if (record.state === "received" || record.state === "processed") {
        continue;
      }
      if (record.state === "failed" || record.state === "expired") {
        continue;
      }
      if (now < record.deadlineAt) {
        continue;
      }
      this.store.set({ ...record, state: "expired" });
      expired += 1;
    }

    return { expired };
  }

  // ------------------------------------------------------------------ helpers

  private resolveRecipients(
    senderConnectionId: string,
    roomId: string | undefined,
    excludeSender: boolean,
  ): string[] {
    if (roomId) {
      const members = this.membership.members(roomId);
      return members.filter((id) => !(excludeSender && id === senderConnectionId));
    }
    return [];
  }

  private async authorizeEvent(
    principal: HubConnectionView["principal"],
    event: string,
    roomId: string | undefined,
    tenantId: string | undefined,
    delivery: DeliveryMode,
  ): Promise<boolean> {
    if (!principal) {
      return false;
    }
    if (!this.authorize) {
      return true;
    }
    const action = `event:${event}`;
    return Boolean(await this.authorize(action, principal, roomId, tenantId));
  }

  private encodeEnvelope(envelope: EventEnvelope): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(envelope));
  }

  private toPublicError(
    error: unknown,
    code: string,
    options?: { retryable?: boolean; details?: unknown },
  ): never {
    const publicError = mapError(error, { registry: this.errorRegistry });
    const overridden: typeof publicError = {
      ...publicError,
      code: code as any,
      retryable: options?.retryable ?? publicError.retryable,
    };
    throw overridden;
  }
}
