/**
 * Transport factory for production-suite integration tests.
 *
 * Spins up a real `createRealtime` server on an ephemeral `127.0.0.1` port
 * backed by the uWebSockets.js engine, and provides raw `WebSocket` clients
 * plus first-party SDK clients for integration scenarios.
 *
 * All servers are tracked and closed in an `afterEach` hook to prevent port
 * exhaustion across the suite.
 */

import { createServer } from "node:net";
import { createRealtime, type RealtimeServer, type RealtimeConfig } from "../../../src/public/create-realtime.js";
import { createRealtimeClient, type RealtimeClient } from "../../../src/client/index.js";
import { decodeFrame, encodeFrame } from "../../../src/protocol/index.js";
import { SilentLogger } from "../../../src/error/logger.js";

const servers: Array<RealtimeServer> = [];

export function trackServer(server: RealtimeServer): void {
  servers.push(server);
}

export async function closeAllServers(): Promise<void> {
  const errors: unknown[] = [];
  while (servers.length > 0) {
    const server = servers.pop();
    try {
      await server?.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw errors[0];
  }
}

/** Reserve an ephemeral port on 127.0.0.1 and release it immediately. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("could not reserve a port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RawClient {
  frames: Array<Record<string, unknown>>;
  // eslint-disable-next-line no-unused-vars
  send(_envelope: Record<string, unknown>): void;
  // eslint-disable-next-line no-unused-vars
  next(_timeout?: number): Promise<Record<string, unknown>>;
  close(): void;
  readonly readyState: number;
}

export function connectRaw(url: string): Promise<RawClient> {
  return connectRawWithRetry(url, 3);
}

async function connectRawWithRetry(url: string, retries: number): Promise<RawClient> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await connectRawOnce(url);
    } catch (error) {
      lastError = error;
      if (attempt < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
  throw lastError;
}

function connectRawOnce(url: string): Promise<RawClient> {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const frames: Array<Record<string, unknown>> = [];
  // eslint-disable-next-line no-unused-vars
  const waiters: Array<(_frame: Record<string, unknown>) => void> = [];

  socket.addEventListener("message", (event: MessageEvent) => {
    const data = event.data;
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : new Uint8Array(data as ArrayBuffer);
    const frame = decodeFrame(bytes, { codec: "json" }).envelope as unknown as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(frame);
      return;
    }
    frames.push(frame);
  });

  return new Promise((resolve, reject) => {
    socket.addEventListener("error", () => reject(new Error("WebSocket error")), { once: true });
    socket.addEventListener(
      "open",
      () => {
        resolve({
          frames,
          send(envelope) {
            socket.send(
              encodeFrame({ protocolVersion: 1, ...envelope } as never, { codec: "json" }),
            );
          },
          next(timeout = 5000) {
            const buffered = frames.shift();
            if (buffered) {
              return Promise.resolve(buffered);
            }
            return new Promise((resolveFrame, rejectFrame) => {
              const timer = setTimeout(() => rejectFrame(new Error("no frame")), timeout);
              waiters.push((frame) => {
                clearTimeout(timer);
                resolveFrame(frame);
              });
            });
          },
          close() {
            socket.close();
          },
          get readyState() {
            return socket.readyState;
          },
        });
      },
      { once: true },
    );
  });
}

export interface TransportServerOptions {
  host?: string;
  port?: number; // reserved ephemeral port when omitted
  path?: string;
  publicUrl?: string;
  allowedOrigins?: string[];
  authenticate?: RealtimeConfig["authenticate"];
  authorize?: RealtimeConfig["authorize"];
  logger?: import("../../../src/error/logger.js").Logger;
  envelopeService?: import("../../../src/e2ee/envelope.js").EnvelopeService;
  roomCapacities?: Record<string, number>;
  limits?: RealtimeConfig["limits"];
  httpHandler?: RealtimeConfig["httpHandler"];
}

export interface TransportServer {
  server: RealtimeServer;
  port: number;
  wsUrl: string;
  close: () => Promise<{
    drainedConnections: number;
    forcedClose: boolean;
    durationMs: number;
  }>;
}

export async function createTransportServer(options: TransportServerOptions = {}): Promise<TransportServer> {
  const port = options.port ?? (await freePort());
  const server = createRealtime({
    host: options.host ?? "127.0.0.1",
    port,
    path: options.path ?? "/ws",
    publicUrl: options.publicUrl,
    allowedOrigins: options.allowedOrigins,
    authenticate: options.authenticate,
    authorize: options.authorize,
    logger: options.logger ?? new SilentLogger(),
    envelopeService: options.envelopeService,
    roomCapacities: options.roomCapacities,
    limits: options.limits,
    httpHandler: options.httpHandler,
  });
  trackServer(server);
  const address = await server.listen();
  return {
    server,
    port: address.port,
    wsUrl: server.wsUrl!,
    close: async () => server.close(),
  };
}

export interface ConnectSdkOptions {
  url: string;
  token?: string | (() => string | Promise<string>);
  reconnect?: { enabled?: boolean; maxAttempts?: number };
  codec?: "json" | "messagepack";
}

export function connectSdk(options: ConnectSdkOptions): RealtimeClient {
  const rawToken = options.token;
  let token: () => string | Promise<string>;
  if (typeof rawToken === "function") {
    token = rawToken;
  } else {
    const value = rawToken ?? "anonymous";
    token = () => value;
  }
  return createRealtimeClient({
    url: options.url,
    auth: { token },
    reconnect: {
      enabled: options.reconnect?.enabled ?? false,
      maxAttempts: options.reconnect?.maxAttempts ?? 0,
    },
    codec: options.codec ?? "json",
  });
}

export { wait };
