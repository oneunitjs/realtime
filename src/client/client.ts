/**
 * Client SDK for `@oneunit/realtime`.
 *
 * Browser-safe entry point: connects to a realtime hub over WebSocket,
 * manages the connection lifecycle, channels, presence, and typed message
 * subscriptions. It consumes the shared protocol codec so server and client
 * speak the same wire format without the application writing framing code.
 *
 * Implements docs/public-api-improvement-plan.md (Phase 5 --- Client SDK)
 * and docs/dx-improvement-plan.md (Section 7).
 */

import {
  decodeFrame,
  encodeFrame,
  jsonCodec,
  messagepackCodec,
  type RealtimeEnvelope,
} from "../protocol/index.js";
import type { Codec, CodecName } from "../protocol/types.js";
import { computeBackoffMs } from "../error/retry.js";
import type { WebSocketTransport } from "./transport.js";
import { createWebSocketTransport } from "./transport.js";
import type {
  ClientMessageHandler,
  ClientPresenceHandler,
  ClientUnsubscribe,
} from "./channel.js";
import { RealtimeClientChannel } from "./channel.js";

/** Connection lifecycle states visible to the application. */
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

/** Reconnection policy. */
export interface ReconnectOptions {
  enabled: boolean;
  maxAttempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** Authentication configuration. */
export interface ClientAuth {
  token: () => string | Promise<string>;
}

/** Client SDK options. */
export interface RealtimeClientOptions {
  url: string;
  auth?: ClientAuth;
  reconnect?: Partial<ReconnectOptions>;
  codec?: CodecName;
  protocols?: string | string[];
}

function resolveReconnectOptions(
  options: Partial<ReconnectOptions> | undefined,
): ReconnectOptions {
  return {
    enabled: options?.enabled ?? true,
    maxAttempts: options?.maxAttempts ?? 10,
    baseDelayMs: options?.baseDelayMs ?? 1000,
    maxDelayMs: options?.maxDelayMs ?? 30_000,
  };
}

/**
 * Create a connected-capable realtime client.
 *
 * Factory form of `RealtimeClient` for the recommended import style.
 */
export function createRealtimeClient(options: RealtimeClientOptions): RealtimeClient {
  return new RealtimeClient(options);
}

export class RealtimeClient {
  private readonly options: RealtimeClientOptions & {
    codec: CodecName;
    protocols: string[];
  };
  private readonly reconnect: ReconnectOptions;
  private readonly codec: Codec;
  private transport: WebSocketTransport | null = null;
  private state: ConnectionState = "disconnected";
  private readonly stateHandlers = new Set<
    (state: ConnectionState | Error) => void
  >();
  private readonly channels = new Map<string, RealtimeClientChannel<unknown>>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private connectingPromise: Promise<void> | null = null;

  constructor(options: RealtimeClientOptions) {
    this.options = {
      ...options,
      codec: options.codec ?? "json",
      protocols: Array.isArray(options.protocols)
        ? options.protocols
        : options.protocols
          ? [options.protocols]
          : [],
    };
    this.reconnect = resolveReconnectOptions(options.reconnect);

    this.codec = this.options.codec === "json" ? jsonCodec : messagepackCodec;
  }

  /** Current connection state. */
  get connected(): boolean {
    return this.state === "connected";
  }

  channel<TMessage = unknown>(name: string): RealtimeClientChannel<TMessage> {
    let existing = this.channels.get(name);
    if (!existing) {
      existing = new RealtimeClientChannel<unknown>(
        name,
        this.transport,
        this.codec,
        this.options.codec,
      );
      this.channels.set(name, existing);
    }
    return existing as RealtimeClientChannel<TMessage>;
  }

  /** Subscribe to lifecycle events. */
  on(
    event: "connected" | "disconnected" | "error",
    handler: (stateOrError: ConnectionState | Error) => void | Promise<void>,
  ): ClientUnsubscribe {
    this.stateHandlers.add(handler as (state: ConnectionState | Error) => void);
    return (): void => {
      this.stateHandlers.delete(
        handler as (state: ConnectionState | Error) => void,
      );
    };
  }

  private emitState(state: ConnectionState | Error): void {
    if (state instanceof Error) {
      this.state = "disconnected";
    } else {
      this.state = state;
    }
    for (const handler of [...this.stateHandlers]) {
      const result = handler(state);
      if (result !== undefined && typeof (result as Promise<unknown>).catch === "function") {
        void (result as Promise<unknown>).catch(() => {
          // Observer failures never interrupt the client lifecycle.
        });
      }
    }
  }

  private emitError(error: Error): void {
    this.state = "disconnected";
    for (const handler of [...this.stateHandlers]) {
      const result = handler(error);
      if (result !== undefined && typeof (result as Promise<unknown>).catch === "function") {
        void (result as Promise<unknown>).catch(() => {
          // Observer failures never interrupt the client lifecycle.
        });
      }
    }
  }

  /** Connect to the hub. Rejects if already closed or connecting. */
  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error("Client is closed; create a new client to reconnect.");
    }
    if (this.connectingPromise) {
      return this.connectingPromise;
    }
    if (this.state === "connected") {
      return;
    }

    this.connectingPromise = this.doConnect();
    try {
      await this.connectingPromise;
    } finally {
      this.connectingPromise = null;
    }
  }

  private async doConnect(): Promise<void> {
    this.emitState("connecting");

    let url = this.options.url;
    if (this.options.auth) {
      const token = await this.options.auth.token();
      const separator = url.includes("?") ? "&" : "?";
      url = `${url}${separator}token=${encodeURIComponent(token)}`;
    }

    const transport = createWebSocketTransport({
      url,
      protocols: this.options.protocols,
    });

    this.transport = transport;
    this.channels.forEach((channel) => channel.attach(transport));

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => resolve();
      const onError = (event: Event) => {
        reject(
          new Error(
            `WebSocket connection failed: ${
              (event as ErrorEvent).message ?? "unknown error"
            }`,
          ),
        );
      };
      transport.addEventListener("open", onOpen, { once: true });
      transport.addEventListener("error", onError, { once: true });

      transport.addEventListener("message", (event) =>
        this.onMessage((event as MessageEvent).data),
      );
      transport.addEventListener("close", () => this.onClose());
    });

    this.reconnectAttempt = 0;
    this.emitState("connected");
    for (const channel of this.channels.values()) {
      if (channel.isJoined()) {
        void channel.join();
      }
    }
  }

  /** Disconnect cleanly. Reconnection is disabled until `connect()` is called again. */
  async disconnect(): Promise<void> {
    this.closed = true;
    this.stopReconnectTimer();
    if (this.transport) {
      this.transport.close(1000, "client disconnect");
      this.transport = null;
    }
    this.channels.forEach((c) => c.close());
    this.channels.clear();
    this.emitState("disconnected");
  }

  private stopReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private onMessage(data: unknown): void {
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      bytes = data;
    } else if (typeof data === "string") {
      bytes = new TextEncoder().encode(data);
    } else {
      return;
    }

    let envelope: RealtimeEnvelope<unknown>;
    try {
      const decoded = decodeFrame(bytes, { codec: this.options.codec });
      envelope = decoded.envelope;
    } catch (error) {
      this.emitError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return;
    }

    const frame = envelope as {
      type?: string;
      channel?: string;
      payload?: unknown;
      name?: string;
      event?: string;
      room?: string;
    };

    if (frame.type === "presence" && frame.channel) {
      const channel = this.channels.get(frame.channel);
      if (channel) {
        channel.receive(frame);
      }
      return;
    }

    if (frame.type === "message" && frame.channel) {
      const channel = this.channels.get(frame.channel);
      if (channel) {
        channel.receive(frame);
      }
      return;
    }

    // Unchannelled frames (welcome, errors, etc.) are surfaced as errors so
    // applications can handle connection-level lifecycle.
    if (frame.type === "error") {
      this.emitError(
        new Error(
          (frame.payload as { message?: string })?.message ??
            "realtime error",
        ),
      );
      return;
    }
  }

  private onClose(): void {
    this.transport = null;
    this.channels.forEach((c) => c.close());

    if (this.closed) {
      this.emitState("disconnected");
      return;
    }

    if (
      this.reconnect.enabled &&
      this.reconnectAttempt < this.reconnect.maxAttempts
    ) {
      this.emitState("reconnecting");
      this.reconnectAttempt += 1;
      const delay = computeBackoffMs({
        attempt: this.reconnectAttempt,
        baseDelayMs: this.reconnect.baseDelayMs ?? 1000,
        multiplier: 2,
        capDelayMs: this.reconnect.maxDelayMs ?? 30_000,
      });
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.doConnect().catch(() => {
          // Reconnect failure is handled by the next timer or terminal state.
        });
      }, delay);
      return;
    }

    this.emitState("disconnected");
  }
}
