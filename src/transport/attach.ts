/**
 * Framework integration helpers for attaching the Realtime Hub to HTTP servers.
 *
 * Per docs/architecture-consolidation-uws-plan-v2.md, uWebSockets.js owns its own
 * native listener and is NOT attached to a Node http.Server `upgrade` event.
 *
 * Two integration patterns are supported:
 *
 *   Pattern A — Dedicated uWS listener (reverse proxy splits traffic):
 *     createHubListener({ hub, path: "/ws", port: 4001 })
 *
 *   Pattern B — Shared Node process, separate uWS listener:
 *     attachHubToServer(server, { hub, path: "/ws", ... })
 *     // server continues to serve HTTP; uWS listens on its own port for WS
 *
 * Framework helpers (Express, Fastify, Koa, Node http) are thin lifecycle
 * wrappers around attachHubToServer / createHubListener.
 */

import type { Hub } from "../core/core-hub.js";
import { createRealtimeTransport, type RealtimeTransport } from "./create-transport.js";
import type { TransportConnection } from "../core/connection/connection.types.js";

// ---------------------------------------------------------------------------
// Attach options
// ---------------------------------------------------------------------------

export interface AttachOptions {
  /** The canonical Hub instance. */
  hub: Hub;
  /** WebSocket upgrade path (e.g. "/ws"). */
  path: string;
  /** Port for the dedicated uWS listener. */
  port: number;
  /** Host to bind. Defaults to "0.0.0.0". */
  host?: string;
  /** Maximum frame size in bytes. */
  maxFrameBytes?: number;
  /** Maximum backpressure in bytes. */
  maxBackpressureBytes?: number;
  /** Allowed Origin values for browser clients. */
  allowedOrigins?: string[];
  /** Allowed subprotocols. */
  allowedSubprotocols?: string[];
  /** Called when a connection is established. */
  onConnection?: (conn: TransportConnection) => void;
  /** Called when a connection closes. */
  onClose?: (id: string, code: number, reason: string, wasClean: boolean) => void;
}

// ---------------------------------------------------------------------------
// createHubListener — standalone uWS listener (Pattern A / C)
// ---------------------------------------------------------------------------

/**
 * Create a dedicated uWS listener for WebSocket connections.
 *
 * This is the highest-performance mode: uWS owns the listener and handles
 * WebSocket upgrades directly. HTTP routes can be registered on the same uWS
 * App, or a reverse proxy can route HTTP to a separate framework server.
 *
 * Awaits the uWS listen callback before resolving so the listener is ready
 * when this returns (no fire-and-forget initialization).
 */
export async function createHubListener(options: AttachOptions): Promise<RealtimeTransport> {
  const adapter = await createRealtimeTransport({
    path: options.path,
    maxFrameBytes: options.maxFrameBytes ?? 64 * 1024,
    maxBackpressureBytes: options.maxBackpressureBytes ?? 256 * 1024,
    allowedOrigins: options.allowedOrigins,
    allowedSubprotocols: options.allowedSubprotocols,
    onConnection: options.onConnection,
    onClose: options.onClose,
  });

  await adapter.listen(options.port, options.host);

  return adapter;
}

// ---------------------------------------------------------------------------
// attachHubToServer — attach to existing Node HTTP server (Pattern B)
// ---------------------------------------------------------------------------

/**
 * Attach the Hub to an existing Node HTTP server.
 *
 * Creates a dedicated uWS listener on a separate port. The HTTP server
 * continues to serve REST/health routes; WebSocket upgrades on the configured
 * path are routed to the uWS listener via a reverse proxy or ingress.
 *
 * Returns the uWS transport adapter and the WebSocket URL that clients
 * should connect to. Awaits the uWS listen callback before resolving.
 */
export async function attachHubToServer(
  server: unknown,
  options: AttachOptions,
): Promise<{ adapter: RealtimeTransport; wsUrl: string }> {
  const adapter = await createRealtimeTransport({
    path: options.path,
    maxFrameBytes: options.maxFrameBytes ?? 64 * 1024,
    maxBackpressureBytes: options.maxBackpressureBytes ?? 256 * 1024,
    allowedOrigins: options.allowedOrigins,
    allowedSubprotocols: options.allowedSubprotocols,
    onConnection: options.onConnection,
    onClose: options.onClose,
  });

  const host = options.host ?? "0.0.0.0";
  const port = options.port;
  const wsUrl = `ws://${host}:${port}${options.path}`;

  await adapter.listen(port, host);

  return { adapter, wsUrl };
}

// ---------------------------------------------------------------------------
// Attach options type is re-exported for consumers building their own
// framework integrations on top of the dedicated uWS listener.
// ---------------------------------------------------------------------------
