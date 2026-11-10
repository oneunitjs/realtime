/**
 * Router.
 *
 * Resolves the recipient set for an event: room members, document
 * subscribers, or explicit recipients. The sender is excluded when event
 * semantics require it. Returns typed delivery outcomes.
 */
import type { TransportConnection } from "../connection/connection.types.js";
import { FanoutScheduler } from "../../event/fanout.js";
import type { Logger } from "../../error/index.js";
import type { Metrics } from "../infrastructure/metrics.js";

export interface RecipientResolution {
  recipients: TransportConnection[];
  senderExcluded: boolean;
}

export class Router {
  constructor(
    private readonly fanout: FanoutScheduler,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    private readonly resolveRoomMembers: (roomId: string) => TransportConnection[],
    private readonly resolveDocumentSubscribers: (
      documentId: string
    ) => TransportConnection[]
  ) {}

  async publishToRoom(
    roomId: string,
    data: Uint8Array,
    senderId: string,
    excludeSender = true
  ): Promise<{ delivered: number; failed: number }> {
    const members = this.resolveRoomMembers(roomId);
    return this.fanOut(members, data, senderId, excludeSender);
  }

  async publishToDocument(
    documentId: string,
    data: Uint8Array,
    senderId: string,
    excludeSender = false
  ): Promise<{ delivered: number; failed: number }> {
    const subscribers = this.resolveDocumentSubscribers(documentId);
    return this.fanOut(subscribers, data, senderId, excludeSender);
  }

  private async fanOut(
    recipients: TransportConnection[],
    data: Uint8Array,
    senderId: string,
    excludeSender: boolean
  ): Promise<{ delivered: number; failed: number }> {
    const start = Date.now();
    let delivered = 0;
    let failed = 0;

    // Fire all enqueues concurrently. The FanoutScheduler bounds in-flight
    // sends globally (default 64) and enforces per-connection queued-byte
    // limits, so fanning out concurrently does not overwhelm the event loop.
    const results = await Promise.all(
      recipients.map(async (recipient) => {
        if (excludeSender && recipient.id === senderId) {
          return "skipped";
        }
        const ok = await this.fanout.enqueue(
          {
            connectionId: recipient.id,
            send: async (d: Uint8Array) => {
              const result = await recipient.send(d);
              if (result.status !== "accepted") {
                throw new Error(
                  `Send not accepted: status=${result.status}`,
                );
              }
            },
          },
          data
        );
        return ok ? "delivered" : "failed";
      }),
    );

    for (const result of results) {
      if (result === "delivered") {
        delivered += 1;
      } else if (result === "failed") {
        failed += 1;
      }
      // "skipped" is neither delivered nor failed
    }

    const elapsed = Date.now() - start;
    this.metrics.increment("publish.fanout", delivered);
    this.metrics.timing("publish.fanout.ms", elapsed);
    return { delivered, failed };
  }
}
