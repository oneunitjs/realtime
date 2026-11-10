/**
 * Client transport abstraction.
 *
 * Implements docs/collab/collaboration-engine.md §9.3 and
 * docs/collab/collaboration-engine-architecture-plan.md §7.5.
 *
 *   - Live editing: WebSocket
 *   - Initial load / large gap: HTTP snapshot + operation fetch
 *   - Background sync: HTTP operation submission + vector
 *   - Awareness: separate message type on same socket
 */

export type TransportMessage =
  | { type: "op"; op: unknown }
  | { type: "ack"; opId: { actorId: string; counter: number }; head: Record<string, number> }
  | { type: "sync"; operations: unknown[]; head: Record<string, number>; snapshot?: unknown }
  | { type: "awareness"; payload: unknown }
  | { type: "error"; code: string; message: string };

export interface Transport {
  connect(): Promise<void>;
  close(): void;
  send(message: TransportMessage): void;
  onMessage(handler: (message: TransportMessage) => void): () => void;
  onClose(handler: (reason?: string) => void): () => void;
  onError(handler: (error: Error) => void): () => void;
  readonly connected: boolean;
}

export class FakeTransport implements Transport {
  private readonly messages: TransportMessage[] = [];
  private messageHandlers = new Array<(m: TransportMessage) => void>();
  private closeHandlers = new Array<(reason?: string) => void>();
  private errorHandlers = new Array<(e: Error) => void>();
  connected = true;
  closed = false;

  async connect(): Promise<void> {
    this.connected = true;
    this.closed = false;
  }
  close(): void {
    this.connected = false;
    this.closed = true;
    for (const h of this.closeHandlers) h();
  }
  send(message: TransportMessage): void {
    if (!this.connected || this.closed) {
      throw new Error("Transport not connected");
    }
    this.messages.push(message);
  }
  onMessage(handler: (m: TransportMessage) => void): () => void {
    this.messageHandlers.push(handler);
    for (const m of this.messages) handler(m);
    this.messages.length = 0;
    return () => {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
    };
  }
  onClose(handler: (reason?: string) => void): () => void {
    this.closeHandlers.push(handler);
    if (this.closed) handler();
    return () => {
      this.closeHandlers = this.closeHandlers.filter((h) => h !== handler);
    };
  }
  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.push(handler);
    return () => {
      this.errorHandlers = this.errorHandlers.filter((h) => h !== handler);
    };
  }

  /** Simulate receiving a message from the server. */
  receive(message: TransportMessage): void {
    for (const h of this.messageHandlers) h(message);
  }

  /** Simulate transport close. */
  closeRemote(reason?: string): void {
    this.connected = false;
    this.closed = true;
    for (const h of this.closeHandlers) h(reason);
  }

  /** Simulate transport error. */
  fail(error: Error): void {
    for (const h of this.errorHandlers) h(error);
  }

  sentMessages(): TransportMessage[] {
    return [...this.messages];
  }
}
