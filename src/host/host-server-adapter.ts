/**
 * Framework lifecycle helpers.
 *
 * These do not replace the uWS listener. They only close the realtime server
 * when the host HTTP process shuts down.
 */

import type { Unsubscribe } from "../core/connection/connection.types.js";

export interface HostServerAdapter {
  readonly kind: string;
  readonly httpServer?: { on?: (event: string, handler: () => void) => void };
  onStart?(callback: () => Promise<void>): Unsubscribe;
  onClose?(callback: () => Promise<void>): Unsubscribe;
  getPublicOrigin?(): string | undefined;
}

export interface ExpressRealtimeOptions {
  httpServer?: { on?: (event: string, handler: () => void) => void };
}

export function expressRealtime(
  _app: unknown,
  realtime: { close?: () => Promise<unknown> | unknown },
  options?: ExpressRealtimeOptions,
): void {
  options?.httpServer?.on?.("close", () => {
    void realtime.close?.();
  });
}

export interface FastifyRealtimeOptions {
  autoRegister?: boolean;
}

export function fastifyRealtime(
  _fastify: unknown,
  realtime: { close?: () => Promise<unknown> | unknown },
  options?: FastifyRealtimeOptions,
): (instance: { onClose?: (hook: () => Promise<void>) => void }) => Promise<void> {
  const plugin = async (instance: { onClose?: (hook: () => Promise<void>) => void }) => {
    instance.onClose?.(async () => {
      await realtime.close?.();
    });
  };
  if (options?.autoRegister === false) {
    return plugin;
  }
  return plugin;
}

export function koaRealtime(
  _app: unknown,
  realtime: { close?: () => Promise<unknown> | unknown },
  options?: { httpServer?: { on?: (event: string, handler: () => void) => void } },
): void {
  options?.httpServer?.on?.("close", () => {
    void realtime.close?.();
  });
}

export function nodeHttpRealtime(
  server: { on?: (event: string, handler: () => void) => void },
  realtime: { close?: () => Promise<unknown> | unknown },
): void {
  server.on?.("close", () => {
    void realtime.close?.();
  });
}
