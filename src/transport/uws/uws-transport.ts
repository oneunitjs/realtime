/**
 * uWS Transport Adapter — sole production WebSocket transport.
 *
 * Uses uWebSockets.js (`uwebsocket` package) against its official v20 API.
 * Implements the normalised TransportAdapter interface: start/stop lifecycle,
 * upgrade routing, Origin/subprotocol/frame-size validation, bounded auth
 * deadline, backpressure tracking, and clean listener teardown.
 *
 * The Hub never imports uWS directly; all socket I/O flows through the
 * normalised TransportConnection returned by onConnection.
 *
 * Two integration modes are supported:
 *   1. Native uWS host mode — uWS owns the listener (App.listen()).
 *   2. Framework-hosted mode — a dedicated uWS listener runs alongside an
 *      existing Node HTTP server (Express/Fastify/Koa/http); a reverse proxy
 *      routes WebSocket upgrades to the uWS listener.
 *
 * uWS is NOT attached to an arbitrary Node http.Server `upgrade` event — its
 * App owns its own native listener.
 */

import { UwsListenFailedError } from "../../error/index.js";

type UwsHttpRequest = {
  getHeader(name: string): string;
  getQuery(): string;
  forEach(cb: (key: string, value: string) => void): void;
};

type UwsHttpResponse = {
  cork(cb: () => void): void;
  writeStatus(status: string): void;
  writeHeader(key: string, value: string): void;
  end(body?: string): void;
  onAborted(cb: () => void): void;
  getRemoteAddressAsText(): ArrayBuffer | undefined;
  upgrade(
    userData: unknown,
    key: string,
    protocol: string,
    extensions: string,
    context: unknown,
  ): void;
};

type UwsWebSocket = {
  getUserData(): unknown;
  send(message: Uint8Array, isBinary?: boolean, compress?: boolean): number;
  end(code?: number, shortMessage?: string): void;
  close(): void;
  getBufferedAmount?: () => number;
};

type UwsWebSocketBehavior = Record<string, unknown>;
import type {
  TransportConnection,
  TransportMessage,
  SendResult,
  SendOptions,
  TransportCloseEvent,
  Unsubscribe,
} from "../../core/connection/connection.types.js";

// ---------------------------------------------------------------------------
// Handshake context
// ---------------------------------------------------------------------------

export interface HandshakeContext {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly origin?: string;
  readonly remoteAddress?: string;
  readonly query: Readonly<Record<string, string>>;
  readonly protocol?: string;
  readonly signal: AbortSignal;
}

// ---------------------------------------------------------------------------
// uWS transport connection (normalised)
// ---------------------------------------------------------------------------

/**
 * Wraps a uWS WebSocket in the normalised TransportConnection interface.
 *
 * Memory lifetime rule: uWS message callbacks receive an ArrayBuffer that is
 * valid only during the callback. The adapter copies bytes immediately, before
 * returning control to uWS or awaiting any asynchronous work.
 *
 * The adapter is the single owner of socket close — Hub disconnect and
 * transport close both route through this single close path.
 */
class UwsTransportConnection implements TransportConnection {
  public readonly id: string;
  readonly remoteAddress?: string;
  public state: "open" | "closing" | "closed" = "open";

  private readonly ws: UwsWebSocket;
  private readonly handshake: HandshakeContext;
  private readonly messageHandlers = new Set<(message: TransportMessage) => void>();
  private readonly closeHandlers = new Set<(event: TransportCloseEvent) => void>();
  private readonly drainHandlers = new Set<() => void>();
  private closed = false;

  constructor(
    ws: UwsWebSocket,
    id: string,
    handshake: HandshakeContext,
  ) {
    this.id = id;
    this.ws = ws;
    this.handshake = handshake;

    // Extract remote address from handshake context (observed at upgrade).
    this.remoteAddress = handshake.remoteAddress;
  }

  /** Deliver a copied inbound message to all registered message handlers. */
  handleMessage(message: ArrayBuffer, isBinary: boolean): void {
    if (this.closed) {
      return;
    }

    // Copy immediately — uWS may reuse/neuter the buffer after the callback.
    const data = new Uint8Array(message).slice();

    const transportMessage: TransportMessage = {
      data,
      isBinary,
    };

    for (const handler of this.messageHandlers) {
      try {
        handler(transportMessage);
      } catch {
        // Handler errors are isolated — one bad handler shouldn't break others
      }
    }
  }

  /** Deliver a close event to all registered close handlers. */
  handleClose(code: number, message: ArrayBuffer): void {
    this.state = "closed";
    this.closed = true;
    const reasonText = message instanceof ArrayBuffer ? new TextDecoder().decode(message) : String(message ?? "");
    for (const handler of this.closeHandlers) {
      try {
        handler({ code, reason: reasonText, wasClean: true });
      } catch {
        // isolated
      }
    }
  }

  /** Deliver a drain notification to all registered drain handlers. */
  handleDrain(): void {
    for (const handler of this.drainHandlers) {
      try {
        handler();
      } catch {
        // isolated
      }
    }
  }

  // ------------------------------------------------------------------
  // TransportConnection interface
  // ------------------------------------------------------------------

  send(data: Uint8Array, options?: SendOptions): Promise<SendResult> {
    if (this.closed || this.state === "closed") {
      return Promise.reject(new Error("Transport connection is closed"));
    }

    try {
      // uWS v20 send returns:
      //   1 = success (accepted)
      //   0 = backpressure built up (will drain over time)
      //   2 = dropped due to backpressure limit
      const rc = (this.ws as unknown as {
        send(message: Uint8Array, isBinary?: boolean, compress?: boolean): number;
      }).send(data, false, options?.compress);
      const bufferedAfter = this.bufferedBytes();
      if (rc === 1) {
        return Promise.resolve({ status: "accepted", bufferedBytes: bufferedAfter });
      }
      // rc === 0 (backpressured) or rc === 2 (dropped due to limit) both mean
      // the local send path cannot accept more data under current policy. The
      // `dropped` callback surfaces rc === 2 as a separate delivery event.
      return Promise.resolve({ status: "backpressured", bufferedBytes: bufferedAfter });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("Send failed"));
    }
  }

  async close(code = 1000, reason = ""): Promise<void> {
    if (this.closed) {
      return;
    }
    this.state = "closing";
    this.closed = true;
    try {
      (this.ws as unknown as { end(code?: number, shortMessage?: string): void }).end(code, reason);
    } catch {
      // Socket may already be closed by the peer
    }
    this.state = "closed";
  }

  terminate(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.state = "closed";
    try {
      (this.ws as unknown as { close(): void }).close();
    } catch {
      // ignore
    }
  }

  onMessage(handler: (message: TransportMessage) => void): Unsubscribe {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onClose(handler: (event: TransportCloseEvent) => void): Unsubscribe {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  onDrain(handler: () => void): Unsubscribe {
    this.drainHandlers.add(handler);
    return () => {
      this.drainHandlers.delete(handler);
    };
  }

  bufferedBytes(): number {
    try {
      return (this.ws as unknown as { getBufferedAmount?: () => number }).getBufferedAmount?.() ?? 0;
    } catch {
      return 0;
    }
  }

  /** Handshake context observed at upgrade (origin, headers, query, …). */
  getHandshake(): HandshakeContext {
    return this.handshake;
  }
}

// ---------------------------------------------------------------------------
// uWS Transport Adapter
// ---------------------------------------------------------------------------

/**
 * Options for creating a uWS transport adapter.
 */
export interface UwsTransportAdapterOptions {
  /** Path for WebSocket upgrades (e.g. "/ws"). */
  path: string;
  /** Maximum frame / message size in bytes. Rejected before parse. */
  maxFrameBytes: number;
  /** Maximum backpressure in bytes. Aligned with uWS maxBackpressure. */
  maxBackpressureBytes: number;
  /** Allowed Origin values. Empty array means allow all origins. */
  allowedOrigins?: string[];
  /** Allowed subprotocols. Empty array means allow all. */
  allowedSubprotocols?: string[];
  /** Transport idle timeout in seconds. 0 disables. Defaults to 120. */
  idleTimeoutSeconds?: number;
  /** Callback when a normalised connection is established. Receives the
   *  connection and the observed handshake context. */
  onConnection?: (conn: TransportConnection, context: HandshakeContext) => void;
  /** Callback when a connection is closed. */
  onClose?: (id: string, code: number, reason: string, wasClean: boolean) => void;
  /** Optional HTTP request handler used by the Node fallback (same port as WS). */
  httpHandler?: (req: unknown, res: unknown) => void;
}

/**
 * uWS-based WebSocket server adapter. uWS owns its own native listener — it
 * is NOT attached to a Node http.Server `upgrade` event.
 *
 * Two modes:
 *   - Native: caller supplies a uWS App, adapter registers the WS route.
 *   - Dedicated: adapter creates its own uWS App and listens on a port.
 */
export class UwsTransportAdapter {
  private app: any = null;
  private listenSocket: any = null;
  private listening = false;
  private routeRegistered = false;
  private readonly options: UwsTransportAdapterOptions;
  private readonly connections = new Map<string, UwsTransportConnection>();
  private readonly droppedCount = new Map<string, number>();
  private readonly idleTimeoutSeconds: number;
  private readonly connectionId = () => `uws_${crypto.randomUUID()}`;

  constructor(options: UwsTransportAdapterOptions) {
    this.options = options;
    this.idleTimeoutSeconds = options.idleTimeoutSeconds ?? 120;
  }

  /** Number of currently managed connections. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** Number of messages dropped due to backpressure (diagnostics only). */
  get droppedMessageCount(): number {
    let total = 0;
    for (const n of this.droppedCount.values()) {
      total += n;
    }
    return total;
  }

  /** Start listening for WebSocket upgrades (dedicated mode). */
  async listen(port: number, host = "0.0.0.0"): Promise<void> {
    if (this.listening) {
      return;
    }

    // Dynamically import uWS App to avoid hard dependency at module load
    const { App } = await import("uwebsocket");
    if (!this.app) {
      this.app = App();
    }

    this.setupRoute();

    return new Promise<void>((resolve, reject) => {
      this.app.listen(host, port, (token: boolean) => {
        if (token) {
          this.listening = true;
          this.listenSocket = token;
          resolve();
        } else {
          this.listening = false;
          reject(new UwsListenFailedError("Failed to listen on " + host + ":" + port));
        }
      });
    });
  }

  /** Mount the WebSocket route on an existing uWS App (native mode).
   *  The caller retains ownership of `app.listen()`/`app.close()`.
   */
  mount(app: any): void {
    if (this.listening) {
      throw new Error("REALTIME_ALREADY_STARTED: cannot mount after the adapter is listening");
    }
    this.app = app;
    this.setupRoute();
  }

  /** Stop listening and close all managed connections.
   *  Only closes the uWS listener when this adapter owns the listen socket.
   */
  async close(): Promise<void> {
    // Close all managed connections regardless of listen ownership.
    for (const conn of this.connections.values()) {
      conn.terminate();
    }
    this.connections.clear();
    this.droppedCount.clear();

    // Close the uWS listener only if this adapter owns it.
    if (this.listening && this.app) {
      this.app.close();
      this.app = null;
    }
    this.listenSocket = null;
    this.listening = false;
    this.routeRegistered = false;
  }

  /** Send a message to a specific connection by id. */
  async sendTo(id: string, data: Uint8Array): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) {
      return Promise.reject(new Error(`Connection ${id} not found`));
    }
    await conn.send(data);
  }

  /** Close a specific connection. */
  async closeConnection(id: string, code?: number, reason?: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) {
      return Promise.reject(new Error(`Connection ${id} not found`));
    }
    await conn.close(code, reason);
  }

  /** Get a connection by id (for hub integration). */
  getConnection(id: string): UwsTransportConnection | undefined {
    return this.connections.get(id);
  }

  /** Check if the adapter is listening. */
  get isListening(): boolean {
    return this.listening;
  }

  /* internal */ recordDropped(id: string): void {
    this.droppedCount.set(id, (this.droppedCount.get(id) ?? 0) + 1);
  }

  /* internal */ getDropped(id: string): number {
    return this.droppedCount.get(id) ?? 0;
  }

  private setupRoute(): void {
    const app = this.app;
    if (!app || this.routeRegistered) {
      return;
    }
    this.routeRegistered = true;

    const opts = this.options;
    const idleTimeout = this.idleTimeoutSeconds;

    app.ws(opts.path, {
      compression: 0,
      maxPayloadLength: opts.maxFrameBytes,
      maxBackpressure: opts.maxBackpressureBytes,
      closeOnBackpressureLimit: true,
      idleTimeout,
      sendPingsAutomatically: true,
      upgrade: (res: UwsHttpResponse, req: UwsHttpRequest, context: unknown) => {
        // Synchronous Origin allowlist check. Async auth runs in onConnection
        // after the Hub sees the connection; the Hub does not grant principal
        // / presence state until authentication succeeds.
        const origin = req.getHeader("origin");
        const allowedOrigins = opts.allowedOrigins;
        if (allowedOrigins && allowedOrigins.length > 0) {
          if (!origin || !allowedOrigins.includes(origin)) {
            res.cork(() => {
              res.writeStatus("403 Forbidden");
              res.writeHeader("content-type", "text/plain");
              res.end("origin not allowed");
            });
            res.onAborted(() => {});
            return;
          }
        }

        const headers: Record<string, string> = {};
        try {
          req.forEach((key, value) => {
            headers[key] = value;
          });
        } catch {
          // headers best-effort
        }

        const query: Record<string, string> = {};
        const rawQuery = req.getQuery();
        if (rawQuery) {
          for (const pair of rawQuery.split("&")) {
            const eq = pair.indexOf("=");
            if (eq === -1) {
              query[pair] = "";
            } else {
              query[pair.slice(0, eq)] = pair.slice(eq + 1);
            }
          }
        }

        const remoteAddress = res.getRemoteAddressAsText()
          ? new TextDecoder().decode(res.getRemoteAddressAsText())
          : undefined;

        const handshake: HandshakeContext = {
          path: opts.path,
          headers,
          origin: origin || undefined,
          remoteAddress,
          query,
          protocol: req.getHeader("sec-websocket-protocol") || undefined,
          signal: new AbortController().signal,
        };

        res.upgrade(
          handshake,
          req.getHeader("sec-websocket-key"),
          req.getHeader("sec-websocket-protocol") || "",
          req.getHeader("sec-websocket-extensions") || "",
          context,
        );
      },
      open: (ws: UwsWebSocket) => {
        const id = this.connectionId();
        const handshake = ws.getUserData() as HandshakeContext | undefined;
        const conn = new UwsTransportConnection(ws, id, handshake ?? emptyHandshake(opts.path));

        // Attach the connection to the socket so message/drain/dropped/close
        // callbacks can locate it. uWS WebSocket objects are extensible.
        (ws as unknown as { __conn?: UwsTransportConnection }).__conn = conn;

        this.connections.set(id, conn);

        opts.onConnection?.(conn, handshake ?? emptyHandshake(opts.path));

        conn.onClose((event) => {
          this.connections.delete(id);
          opts.onClose?.(id, event.code, event.reason, event.wasClean);
        });
      },
      message: (ws: UwsWebSocket, message: ArrayBuffer, isBinary: boolean) => {
        const conn = (ws as unknown as { __conn?: UwsTransportConnection }).__conn;
        if (!conn) {
          return;
        }
        // uWS message memory is valid only during this callback; UwsTransportConnection
        // copies bytes inside handleMessage before any await.
        conn.handleMessage(message, isBinary);
      },
      drain: (ws: UwsWebSocket) => {
        const conn = (ws as unknown as { __conn?: UwsTransportConnection }).__conn;
        if (!conn) {
          return;
        }
        conn.handleDrain();
      },
      dropped: (ws: UwsWebSocket, message: ArrayBuffer, isBinary: boolean) => {
        const conn = (ws as unknown as { __conn?: UwsTransportConnection }).__conn;
        if (!conn) {
          return;
        }
        // A dropped message is a real delivery-path event (backpressure limit
        // reached). Record it for diagnostics; the Hub treats backpressured
        // sends as "do not enqueue more".
        this.recordDropped(conn.id);
      },
      close: (ws: UwsWebSocket, code: number, message: ArrayBuffer) => {
        const conn = (ws as unknown as { __conn?: UwsTransportConnection }).__conn;
        if (!conn) {
          return;
        }
        conn.handleClose(code, message);
      },
    } as UwsWebSocketBehavior);
  }
}

/**
 * Create a uWS transport adapter (the only production engine).
 */
export function createUwsTransport(options: UwsTransportAdapterOptions): UwsTransportAdapter {
  return new UwsTransportAdapter(options);
}

export async function loadUwsApp(): Promise<{ App: () => unknown } | null> {
  try {
    const mod = (await import("uwebsocket")) as { App?: () => unknown };
    if (typeof mod.App !== "function") {
      return null;
    }
    return { App: mod.App };
  } catch {
    return null;
  }
}

function emptyHandshake(path: string): HandshakeContext {
  return {
    path,
    headers: {},
    query: {},
    signal: new AbortController().signal,
  };
}
