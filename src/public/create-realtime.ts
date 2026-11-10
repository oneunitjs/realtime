/**
 * Public facade — createRealtime() is the production entry point.
 *
 *   const realtime = createRealtime({ port: 4001 });
 *   await realtime.listen();
 *   console.log(realtime.wsUrl);
 *   await realtime.close();
 *
 * The engine is always uWebSockets.js. Framework helpers (Express/Fastify/Koa)
 * only hook host lifecycle; they do not replace the uWS listener.
 */

import { Hub, type HubOptions } from "../core/core-hub.js";
import {
  anonymousAuthProvider,
  credentialFromHandshake,
  type AuthProvider,
} from "../core/auth/auth-provider.js";
import type {
  AuthenticatedPrincipal,
  HandshakeContext,
  Principal,
  Unsubscribe,
} from "../core/connection/connection.types.js";
import { HostIntegrationInvalidError } from "../error/index.js";
import type { Logger } from "../error/logger.js";
import { SilentLogger } from "../error/logger.js";
import {
  createRealtimeTransport,
  type RealtimeTransport,
} from "../transport/create-transport.js";
import type { UwsTransportAdapterOptions } from "../transport/uws/uws-transport.js";
import type { EnvelopeService } from "../e2ee/envelope.js";

export type RealtimeState =
  | "created"
  | "starting"
  | "ready"
  | "draining"
  | "closed"
  | "failed";

export type RealtimeMode = "dedicated" | "native";

export type RealtimeEngine = "uwebsockets";

export interface RealtimeAddress {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly publicUrl?: string;
}

export interface RealtimeShutdownResult {
  readonly drainedConnections: number;
  readonly forcedClose: boolean;
  readonly durationMs: number;
}

export interface RealtimeHealth {
  readonly healthy: boolean;
  readonly readyMessage: string;
  readonly address: RealtimeAddress | null;
  readonly connectionCount: number;
}

export interface RealtimeLimitsConfig {
  readonly maxPayloadBytes?: number;
  readonly maxBackpressureBytes?: number;
  readonly maxConnections?: number;
  readonly authTimeoutMs?: number;
}

export interface RealtimeAuthConfig {
  readonly authenticate: (context: HandshakeContext) => Promise<AuthenticatedPrincipal>;
}

export interface RealtimeTransportConfig {
  readonly engine?: RealtimeEngine;
  readonly mode?: RealtimeMode;
  readonly path?: string;
  readonly listen?: { host?: string; port: number };
  readonly publicUrl?: string;
  readonly maxPayloadBytes?: number;
  readonly maxBackpressureBytes?: number;
  readonly allowedOrigins?: string[];
  readonly allowedSubprotocols?: string[];
  readonly app?: unknown;
}

export interface RealtimeConfig {
  readonly port?: number;
  readonly host?: string;
  readonly path?: string;
  readonly publicUrl?: string;
  readonly allowedOrigins?: string[];
  readonly authenticate?: (context: HandshakeContext) => Promise<AuthenticatedPrincipal>;
  readonly authorize?: HubOptions["authorize"];
  readonly logger?: Logger;
  readonly envelopeService?: EnvelopeService;
  readonly roomCapacities?: Record<string, number>;
  readonly transport?: RealtimeTransportConfig;
  readonly auth?: RealtimeAuthConfig;
  readonly limits?: RealtimeLimitsConfig;
  readonly httpHandler?: (req: unknown, res: unknown) => void;
}

export type { HandshakeContext, AuthenticatedPrincipal };

export interface RealtimeServer {
  readonly state: RealtimeState;
  readonly address: RealtimeAddress | null;
  readonly wsUrl: string | null;
  readonly hub: Hub;

  listen(): Promise<RealtimeAddress>;
  start(): Promise<RealtimeAddress>;
  close(options?: { timeoutMs?: number }): Promise<RealtimeShutdownResult>;
  health(): RealtimeHealth;
  on(event: "ready" | "error" | "closed", listener: (arg: unknown) => void): Unsubscribe;
}

const CLOSE_DEADLINE_DEFAULT_MS = 5_000;
const DEFAULT_PATH = "/ws";
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_MAX_PAYLOAD = 64 * 1024;
const DEFAULT_MAX_BACKPRESSURE = 256 * 1024;

export function createRealtime(config: RealtimeConfig = {}): RealtimeServer {
  return new RealtimeServerImpl(config);
}

class RealtimeServerImpl implements RealtimeServer {
  private _state: RealtimeState = "created";
  private _address: RealtimeAddress | null = null;
  private _wsUrl: string | null = null;
  private adapter: RealtimeTransport | null = null;
  private readonly adapterOpts: UwsTransportAdapterOptions;
  private startPromise: Promise<RealtimeAddress> | null = null;
  private closePromise: Promise<RealtimeShutdownResult> | null = null;
  private readonly listeners = new Map<string, Set<(arg: unknown) => void>>();
  private lifecycleLock: Promise<unknown> = Promise.resolve();

  private readonly mode: RealtimeMode;
  private readonly path: string;
  private readonly host: string;
  private readonly port: number | undefined;
  private readonly publicUrl: string | undefined;
  private readonly nativeApp: unknown;
  private readonly logger: Logger;
  readonly hub: Hub;

  constructor(config: RealtimeConfig) {
    const transport = config.transport ?? {};
    if (transport.engine !== undefined && transport.engine !== "uwebsockets") {
      throw new HostIntegrationInvalidError(
        `Unsupported transport engine "${String(transport.engine)}". Only "uwebsockets" is supported.`,
      );
    }

    this.mode = transport.mode ?? "dedicated";
    this.path = config.path ?? transport.path ?? DEFAULT_PATH;
    this.host = config.host ?? transport.listen?.host ?? DEFAULT_HOST;
    this.port = config.port ?? transport.listen?.port;
    this.publicUrl = config.publicUrl ?? transport.publicUrl;
    this.nativeApp = transport.app;
    this.logger = config.logger ?? new SilentLogger();

    const authProvider = this.buildAuthProvider(config);
    const hubOptions: HubOptions = {
      authProvider,
      authorize: config.authorize,
      logger: this.logger,
      envelopeService: config.envelopeService,
      roomCapacities: config.roomCapacities,
      config: {
        maxConnections: config.limits?.maxConnections,
        maxFrameBytes: config.limits?.maxPayloadBytes ?? transport.maxPayloadBytes,
        maxQueuedBytesPerConnection:
          config.limits?.maxBackpressureBytes ?? transport.maxBackpressureBytes,
        authTimeoutMs: config.limits?.authTimeoutMs,
      },
    };
    this.hub = new Hub(hubOptions);

    const maxPayload =
      config.limits?.maxPayloadBytes ?? transport.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD;
    const maxBackpressure =
      config.limits?.maxBackpressureBytes ??
      transport.maxBackpressureBytes ??
      DEFAULT_MAX_BACKPRESSURE;

    const adapterOpts: UwsTransportAdapterOptions = {
      path: this.path,
      maxFrameBytes: maxPayload,
      maxBackpressureBytes: maxBackpressure,
      allowedOrigins: config.allowedOrigins ?? transport.allowedOrigins,
      allowedSubprotocols: transport.allowedSubprotocols,
      httpHandler: config.httpHandler,
      onConnection: (conn, handshake) => {
        void this.hub.connect(conn, undefined, handshake).catch((err) => {
          this.logger.error?.({ err }, "connect failed");
          void conn.close(1008, "unauthorized");
        });
      },
    };

    this.adapterOpts = adapterOpts;
  }

  get state(): RealtimeState {
    return this._state;
  }

  get address(): RealtimeAddress | null {
    return this._address;
  }

  get wsUrl(): string | null {
    return this._wsUrl;
  }

  listen(): Promise<RealtimeAddress> {
    return this.start();
  }

  async start(): Promise<RealtimeAddress> {
    // Serialize through lifecycle lock to prevent start/close races.
    this.lifecycleLock = this.lifecycleLock.then(async () => {
      if (this._state === "closed") {
        throw new Error("REALTIME_ALREADY_CLOSED: Cannot start after close");
      }
      if (this._state === "failed") {
        throw new Error("REALTIME_START_FAILED: Previous start failed");
      }
      if (this.startPromise) {
        return this.startPromise;
      }
      if (this._state === "ready") {
        return Promise.resolve(this._address as RealtimeAddress);
      }
      if (this._state === "draining") {
        throw new Error(
          "REALTIME_CLOSING: Cannot start while server is draining",
        );
      }

      this._state = "starting";
      this.startPromise = this.doStart();
      return this.startPromise;
    });

    return this.lifecycleLock as Promise<RealtimeAddress>;
  }

  private async doStart(): Promise<RealtimeAddress> {
    this.adapter = await createRealtimeTransport(this.adapterOpts);

    if (this.mode === "native") {
      if (!this.nativeApp) {
        const err = new HostIntegrationInvalidError(
          "Native mode requires a uWS App in transport.app",
        );
        this._state = "failed";
        this.emit("error", err);
        throw err;
      }
      try {
        this.adapter.mount(this.nativeApp);
      } catch (error) {
        this._state = "failed";
        const err = error instanceof Error ? error : new Error(String(error));
        this.emit("error", err);
        throw err;
      }
      if (this.port !== undefined) {
        try {
          await this.adapter.listen(this.port, this.host);
        } catch (error) {
          this._state = "failed";
          const err = error instanceof Error ? error : new Error(String(error));
          this.emit("error", err);
          throw err;
        }
      }
      const address = this.buildAddress(this.port ?? 0);
      this.markReady(address);
      return address;
    }

    if (this.port === undefined) {
      const err = new HostIntegrationInvalidError("port is required for dedicated mode");
      this._state = "failed";
      this.emit("error", err);
      throw err;
    }

    try {
      await this.adapter!.listen(this.port, this.host);
      const address = this.buildAddress(this.port);
      this.markReady(address);
      return address;
    } catch (error) {
      this._state = "failed";
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit("error", err);
      throw err;
    }
  }

  async close(options?: { timeoutMs?: number }): Promise<RealtimeShutdownResult> {
    // Serialize through lifecycle lock to prevent start/close races.
    this.lifecycleLock = this.lifecycleLock.then(async () => {
      if (this.closePromise) {
        return this.closePromise;
      }
      if (this._state === "closed") {
        return { drainedConnections: 0, forcedClose: false, durationMs: 0 };
      }

      this._state = "draining";
      this.closePromise = this.doClose(options?.timeoutMs ?? CLOSE_DEADLINE_DEFAULT_MS);
      return this.closePromise;
    });

    return this.lifecycleLock as Promise<RealtimeShutdownResult>;
  }

  private async doClose(timeoutMs: number): Promise<RealtimeShutdownResult> {
    const started = Date.now();
    const connectionCount = this.adapter?.connectionCount ?? 0;
    let hubCloseError: unknown;
    let timeoutWon = false;

    try {
      await this.hub.close();
    } catch (error) {
      hubCloseError = error;
      this.logger.error?.({ err: error }, "Hub shutdown failed");
    } finally {
      let resolved = false;
      const timeoutTimer = setTimeout(() => {
        timeoutWon = true;
        resolved = true;
      }, timeoutMs);

      try {
        await this.adapter?.close() ?? Promise.resolve();
      } catch (error) {
        this.logger.error?.({ err: error }, "close error");
      }

      if (!resolved) {
        clearTimeout(timeoutTimer);
      }
      this.adapter = null;
    }

    this._state = "closed";
    const result: RealtimeShutdownResult = {
      drainedConnections: connectionCount,
      forcedClose: timeoutWon,
      durationMs: Date.now() - started,
    };
    this.emit("closed", result);
    return result;
  }

  health(): RealtimeHealth {
    return {
      healthy: this._state === "ready",
      readyMessage: this._state === "ready" ? "ready" : this._state,
      address: this._address,
      connectionCount: this.adapter?.connectionCount ?? 0,
    };
  }

  on(event: "ready" | "error" | "closed", listener: (arg: unknown) => void): Unsubscribe {
    const set = this.listeners.get(event) ?? new Set<(arg: unknown) => void>();
    this.listeners.set(event, set);
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  private emit(event: "ready" | "error" | "closed", payload: unknown): void {
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    for (const fn of set) {
      try {
        fn(payload);
      } catch {
        // isolated
      }
    }
  }

  private buildAuthProvider(config: RealtimeConfig): AuthProvider {
    const authenticate = config.authenticate ?? config.auth?.authenticate;
    if (!authenticate) {
      return anonymousAuthProvider;
    }
    return {
      authenticate: async (credential, options) => {
        const handshake = options.handshake ?? {
          path: this.path,
          headers: {},
          query: credential ? { token: credential } : {},
          signal: options.signal,
        };
        const principal = await authenticate(handshake);
        return normalizePrincipal(principal, credential);
      },
    };
  }

  private buildAddress(port: number): RealtimeAddress {
    return {
      host: this.host,
      port,
      path: this.path,
      publicUrl: this.publicUrl,
    };
  }

  private markReady(address: RealtimeAddress): void {
    this._address = address;
    this._wsUrl = this.makeWsUrl(address);
    this._state = "ready";
    this.emit("ready", address);
  }

  private makeWsUrl(address: RealtimeAddress): string | null {
    if (address.publicUrl) {
      return address.publicUrl;
    }
    const host = address.host === "0.0.0.0" ? "127.0.0.1" : address.host;
    if (host.includes("*")) {
      return null;
    }
    return `ws://${host}:${address.port}${address.path}`;
  }
}

function normalizePrincipal(
  principal: AuthenticatedPrincipal,
  credential: string | undefined,
): Principal {
  return {
    userId: principal.userId,
    tenantId: principal.tenantId,
    roles: principal.roles ?? ["user"],
    sessionId: principal.sessionId ?? credential ?? principal.userId,
  };
}

export { credentialFromHandshake };
