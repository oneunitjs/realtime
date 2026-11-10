/**
 * Bounded fan-out scheduler.
 *
 * Dispatches an encoded envelope to a set of recipients with bounded
 * concurrency, per-connection queue limits, and transport backpressure
 * handling. Slow recipients are isolated so one blocked connection does not
 * stall unrelated recipients. Partial failures are recorded without
 * converting the entire fan-out into an all-or-nothing result.
 *
 * No network I/O occurs while a room membership lock is held; the caller
 * must pass an already-resolved recipient list (authorized snapshot).
 */

export interface FanoutRecipient {
  connectionId: string;
  /** Send the encoded bytes to this recipient's local transport. Resolves
   *  when the transport accepted the bytes (→ "written"); rejects on
   *  failure/closed/backpressure. */
  send: (encoded: Uint8Array) => Promise<void>;
}

export interface FanoutOptions {
  /** Max concurrent in-flight sends. Default 64. */
  concurrency?: number;
  /** Per-connection queued byte limit. Default 256 KiB. */
  maxQueuedBytesPerConnection?: number;
}

interface PendingSend {
  recipient: FanoutRecipient;
  encoded: Uint8Array;
  resolve: (ok: boolean) => void;
}

export class FanoutScheduler {
  private readonly queues = new Map<string, PendingSend[]>(); // connectionId → pending sends
  private readonly queuedBytes = new Map<string, number>(); // connectionId → bytes
  private readonly active = new Set<string>(); // connectionIds currently being drained
  private readonly concurrency: number;
  private readonly maxQueuedBytesPerConnection: number;
  private inFlight = 0;

  constructor(options: FanoutOptions = {}) {
    this.concurrency = options.concurrency ?? 64;
    this.maxQueuedBytesPerConnection = options.maxQueuedBytesPerConnection ?? 256 * 1024;
  }

  /**
   * Enqueue a send for a recipient. Returns a promise that resolves to
   * `false` if the recipient's queue is over its byte limit (drop under
   * backpressure), `true` when the transport accepted the bytes.
   */
  enqueue(recipient: FanoutRecipient, encoded: Uint8Array): Promise<boolean> {
    const id = recipient.connectionId;
    const current = this.queuedBytes.get(id) ?? 0;

    if (current + encoded.byteLength > this.maxQueuedBytesPerConnection) {
      return Promise.resolve(false); // drop under backpressure
    }

    let queue = this.queues.get(id);
    if (!queue) {
      queue = [];
      this.queues.set(id, queue);
    }

    let resolve!: (ok: boolean) => void;
    const promise = new Promise<boolean>((res) => {
      resolve = res;
    });

    queue.push({ recipient, encoded, resolve });
    this.queuedBytes.set(id, current + encoded.byteLength);

    void this.drain(id);
    return promise;
  }

  /** Drain one recipient's queue up to concurrency limits. */
  private async drain(connectionId: string): Promise<void> {
    if (this.active.has(connectionId)) {
      return; // already draining
    }
    this.active.add(connectionId);

    try {
      while (true) {
        // Respect global concurrency limit.
        while (this.inFlight >= this.concurrency) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        const item = this.shift(connectionId);
        if (!item) {
          break;
        }

        this.inFlight += 1;
        try {
          await item.recipient.send(item.encoded);
          this.queuedBytes.set(
            connectionId,
            Math.max(0, (this.queuedBytes.get(connectionId) ?? 0) - item.encoded.byteLength),
          );
          item.resolve(true);
        } catch {
          this.queuedBytes.set(
            connectionId,
            Math.max(0, (this.queuedBytes.get(connectionId) ?? 0) - item.encoded.byteLength),
          );
          item.resolve(false);
        } finally {
          this.inFlight -= 1;
        }
      }
    } finally {
      this.active.delete(connectionId);
    }
  }

  private shift(connectionId: string): PendingSend | undefined {
    const queue = this.queues.get(connectionId);
    if (!queue || queue.length === 0) {
      this.queues.delete(connectionId);
      this.queuedBytes.delete(connectionId);
      return undefined;
    }
    return queue.shift();
  }

  queuedBytesFor(connectionId: string): number {
    return this.queuedBytes.get(connectionId) ?? 0;
  }

  pendingCount(connectionId: string): number {
    return this.queues.get(connectionId)?.length ?? 0;
  }
}
