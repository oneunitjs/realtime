/**
 * Fair, bounded fan-out scheduler.
 *
 * Each connection has a FIFO queue and at most one active send. Different
 * connections are dispatched round-robin up to the global concurrency limit.
 * Queued-byte accounting includes in-flight sends, so a slow transport cannot
 * silently grow memory without bound.
 */

export interface FanoutRecipient {
  connectionId: string;
  /** Resolves when the transport accepts the bytes; rejects on send failure. */
  send: (encoded: Uint8Array) => Promise<void>;
}

export interface FanoutOptions {
  /** Maximum number of sends in flight across all connections. Default: 64. */
  concurrency?: number;
  /** Maximum queued plus in-flight bytes per connection. Default: 256 KiB. */
  maxQueuedBytesPerConnection?: number;
}

interface PendingSend {
  recipient: FanoutRecipient;
  encoded: Uint8Array;
  resolve: (ok: boolean) => void;
}

export class FanoutScheduler {
  private readonly queues = new Map<string, PendingSend[]>();
  private readonly queuedBytes = new Map<string, number>();
  private readonly active = new Set<string>();
  private readonly ready: string[] = [];
  private readonly readySet = new Set<string>();
  private readonly concurrency: number;
  private readonly maxQueuedBytesPerConnection: number;
  private inFlight = 0;
  private pumping = false;

  constructor(options: FanoutOptions = {}) {
    this.concurrency = options.concurrency ?? 64;
    this.maxQueuedBytesPerConnection = options.maxQueuedBytesPerConnection ?? 256 * 1024;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1) {
      throw new RangeError("concurrency must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxQueuedBytesPerConnection) || this.maxQueuedBytesPerConnection < 0) {
      throw new RangeError("maxQueuedBytesPerConnection must be a non-negative safe integer");
    }
  }

  enqueue(recipient: FanoutRecipient, encoded: Uint8Array): Promise<boolean> {
    if (!recipient.connectionId || typeof recipient.connectionId !== "string") {
      return Promise.resolve(false);
    }
    if (!(encoded instanceof Uint8Array)) return Promise.resolve(false);

    const id = recipient.connectionId;
    const current = this.queuedBytes.get(id) ?? 0;
    if (encoded.byteLength > this.maxQueuedBytesPerConnection - current) {
      return Promise.resolve(false);
    }

    let queue = this.queues.get(id);
    if (!queue) {
      queue = [];
      this.queues.set(id, queue);
    }

    const result = new Promise<boolean>((resolve) => {
      queue!.push({ recipient, encoded, resolve });
    });
    this.queuedBytes.set(id, current + encoded.byteLength);
    this.markReady(id);
    this.pump();
    return result;
  }

  /** Bytes retained for this connection, including the active send. */
  queuedBytesFor(connectionId: string): number {
    return this.queuedBytes.get(connectionId) ?? 0;
  }

  /** Number waiting to start; does not include an in-flight send. */
  pendingCount(connectionId: string): number {
    return this.queues.get(connectionId)?.length ?? 0;
  }

  private markReady(id: string): void {
    if (!this.active.has(id) && !this.readySet.has(id) && (this.queues.get(id)?.length ?? 0) > 0) {
      this.ready.push(id);
      this.readySet.add(id);
    }
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.inFlight < this.concurrency && this.ready.length > 0) {
        const id = this.ready.shift()!;
        this.readySet.delete(id);
        if (this.active.has(id)) continue;
        const queue = this.queues.get(id);
        const item = queue?.shift();
        if (!item) {
          this.cleanupIfIdle(id);
          continue;
        }

        this.active.add(id);
        this.inFlight++;
        // Promise.resolve().then also catches transports that throw before
        // returning a promise, keeping scheduler bookkeeping consistent.
        void Promise.resolve()
          .then(() => item.recipient.send(item.encoded))
          .then(
            () => this.finishSend(id, item, true),
            () => this.finishSend(id, item, false),
          );
      }
    } finally {
      this.pumping = false;
    }
  }

  private finishSend(id: string, item: PendingSend, ok: boolean): void {
    this.queuedBytes.set(id, Math.max(0, (this.queuedBytes.get(id) ?? 0) - item.encoded.byteLength));
    this.inFlight--;
    this.active.delete(id);
    this.markReady(id);
    this.cleanupIfIdle(id);
    // Resolve after accounting is updated so observers see a consistent state.
    item.resolve(ok);
    this.pump();
  }

  private cleanupIfIdle(id: string): void {
    if (!this.active.has(id) && (this.queues.get(id)?.length ?? 0) === 0) {
      this.queues.delete(id);
      this.queuedBytes.delete(id);
      this.readySet.delete(id);
    }
  }
}
