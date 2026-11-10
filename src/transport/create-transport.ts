/**
 * Choose a WebSocket listener: uWebSockets.js when the native addon loads,
 * otherwise a Node http upgrade fallback with the same TransportConnection
 * contract.
 */

import {
  createUwsTransport,
  loadUwsApp,
  type UwsTransportAdapter,
  type UwsTransportAdapterOptions,
} from "./uws/uws-transport.js";
import { NodeHttpTransportAdapter } from "./node-http/node-http-transport.js";

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
  if (uws) {
    try {
      uws.App();
      return createUwsTransport(options);
    } catch {
      // Native addon present but unusable (ABI/glibc). Fall through.
    }
  }
  return new NodeHttpTransportAdapter(options);
}

export type { UwsTransportAdapter, UwsTransportAdapterOptions };
