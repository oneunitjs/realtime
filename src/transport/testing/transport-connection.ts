/**
 * Fake transport connections for the Core Hub.
 *
 * In-memory TransportConnection for tests. `send` records outbound frames;
 * `receive` delivers inbound frames. They are never the same path.
 */

import type {
  TransportConnection,
  TransportMessage,
  SendResult,
  SendOptions,
  TransportCloseEvent,
  Unsubscribe,
} from "../../core/connection/connection.types.js";

export class FakeTransport implements TransportConnection {
  readonly id: string;
  readonly remoteAddress?: string;
  public state: "open" | "closing" | "closed" = "open";
  public closed = false;
  readonly sent: TransportMessage[] = [];
  private closeReason?: string;
  private errored = false;
  private closeError?: Error;
  private onCloseHandlers = new Array<(event: TransportCloseEvent) => void>();
  private onErrorHandlers = new Array<(error: Error) => void>();
  private onMessageHandlers = new Array<(message: TransportMessage) => void>();
  private onDrainHandlers = new Array<() => void>();
  private onSendHandlers = new Array<(message: TransportMessage) => void>();

  constructor(id: string) {
    this.id = id;
  }

  send(data: Uint8Array, _options?: SendOptions): Promise<SendResult> {
    if (this.closed || this.errored || this.state === "closed") {
      return Promise.reject(new Error("transport is closed"));
    }
    const message: TransportMessage = { data: new Uint8Array(data), isBinary: true };
    this.sent.push(message);
    for (const handler of this.onSendHandlers) {
      try {
        handler(message);
      } catch {
        // isolated
      }
    }
    return Promise.resolve({ status: "accepted", bufferedBytes: 0 });
  }

  async close(code = 1000, reason = ""): Promise<void> {
    if (this.closed) {
      return;
    }
    this.state = "closed";
    this.closed = true;
    this.closeReason = reason;
    const handlers = [...this.onCloseHandlers];
    this.onCloseHandlers = [];
    for (const handler of handlers) {
      try {
        handler({ code, reason, wasClean: true });
      } catch {
        // isolated
      }
    }
  }

  terminate(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.state = "closed";
  }

  onMessage(handler: (message: TransportMessage) => void): Unsubscribe {
    this.onMessageHandlers.push(handler);
    return () => {
      this.onMessageHandlers = this.onMessageHandlers.filter((h) => h !== handler);
    };
  }

  onSend(handler: (message: TransportMessage) => void): Unsubscribe {
    this.onSendHandlers.push(handler);
    return () => {
      this.onSendHandlers = this.onSendHandlers.filter((h) => h !== handler);
    };
  }

  onClose(handler: (event: TransportCloseEvent) => void): Unsubscribe {
    this.onCloseHandlers.push(handler);
    if (this.closed) {
      handler({ code: 1000, reason: this.closeReason ?? "", wasClean: true });
    }
    return () => {
      this.onCloseHandlers = this.onCloseHandlers.filter((h) => h !== handler);
    };
  }

  onDrain(handler: () => void): Unsubscribe {
    this.onDrainHandlers.push(handler);
    return () => {
      this.onDrainHandlers = this.onDrainHandlers.filter((h) => h !== handler);
    };
  }

  bufferedBytes(): number {
    return 0;
  }

  receive(data: Uint8Array, isBinary = true): void {
    if (this.closed || this.errored) {
      return;
    }
    const message: TransportMessage = { data: new Uint8Array(data), isBinary };
    for (const handler of this.onMessageHandlers) {
      try {
        handler(message);
      } catch {
        // isolated
      }
    }
  }

  closeRemote(code = 1000, reason = ""): void {
    this.closed = true;
    this.state = "closed";
    this.closeReason = reason;
    const handlers = [...this.onCloseHandlers];
    this.onCloseHandlers = [];
    for (const handler of handlers) {
      try {
        handler({ code, reason, wasClean: true });
      } catch {
        // isolated
      }
    }
  }

  fail(error: Error): void {
    this.errored = true;
    this.closeError = error;
    const handlers = [...this.onErrorHandlers];
    this.onErrorHandlers = [];
    for (const handler of handlers) {
      try {
        handler(error);
      } catch {
        // isolated
      }
    }
  }
}

export function createFakeTransportPair(): [FakeTransport, FakeTransport] {
  const a = new FakeTransport("fake-a");
  const b = new FakeTransport("fake-b");
  a.onSend((msg) => b.receive(msg.data, msg.isBinary));
  b.onSend((msg) => a.receive(msg.data, msg.isBinary));
  return [a, b];
}
