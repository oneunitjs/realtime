/**
 * Create a uWebSockets.js transport adapter. uWebSockets.js is the sole
 * WebSocket engine for this package; there is no Node http fallback.
 */

import {
  createUwsTransport,
  loadUwsApp,
  type UwsTransportAdapter,
  type UwsTransportAdapterOptions,
} from "./uws/uws-transport.js";

export interface RealtimeTransport {
  readonly connectionCount: number;
  readonly isListening: boolean;
  listen(port: number, host?: string): Promise<void>;
  mount(app: unknown): void;
  close(): Promise<void>;
}

export async function createRealtimeTransport(
  options: UwsTransportAdapterOptions,
): Promise<RealtimeTransport> {
  const uws = await loadUwsApp();
  if (!uws) {
    throw new Error(
      "uWebSockets.js is required but not available. Install the uwebsocket dependency.",
    );
  }
  try {
    uws.App();
    return createUwsTransport(options);
  } catch (error) {
    throw new Error(
      `uWebSockets.js is present but unusable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export type { UwsTransportAdapter, UwsTransportAdapterOptions };
