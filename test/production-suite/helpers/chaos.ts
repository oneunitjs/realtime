/**
 * Chaos engineering helpers for production-suite robustness tests.
 *
 * Injects faults into transports and auth providers so tests can assert
 * fail-closed behavior, idempotent cleanup, and graceful degradation under
 * load.
 */

import type { FakeTransport } from "../../../src/transport/testing/transport-connection.js";
import type { AuthProvider } from "../../../src/core/auth/auth-provider.js";
import type { Principal } from "../../../src/core/connection/connection.types.js";
import { makeAuthProvider } from "./hub-factory.js";

/** Wrap a FakeTransport so `send` resolves after `delayMs`. */
export function slowSendTransport(transport: FakeTransport, delayMs: number): FakeTransport {
  const original = transport.send.bind(transport);
  transport.send = async (data, options) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return original(data, options);
  };
  return transport;
}

/** Wrap a FakeTransport so `send` rejects after `maxSends` accepted sends. */
export function failingSendTransport(
  transport: FakeTransport,
  options: { failAfterSends?: number; error?: Error } = {},
): FakeTransport {
  let sends = 0;
  const { failAfterSends = 1, error = new Error("send injection failure") } = options;
  const original = transport.send.bind(transport);
  transport.send = async (data, options_) => {
    sends += 1;
    if (sends >= failAfterSends) {
      throw error;
    }
    return original(data, options_);
  };
  return transport;
}

/** Wrap a FakeTransport so `send` never resolves (hangs). */
export function hangingSendTransport(transport: FakeTransport): FakeTransport {
  const original = transport.send.bind(transport);
  transport.send = async () => {
    await new Promise(() => {});
    return original(new Uint8Array(0));
  };
  return transport;
}

/** Build an auth provider that throws, times out, or returns unknown credentials. */
export function chaosAuthProvider(options: {
  shouldFail?: boolean;
  throwAfterMs?: number;
  delayMs?: number;
  principal?: Principal;
  byCredential?: Record<string, Principal>;
}): AuthProvider {
  return makeAuthProvider({
    principal: options.principal,
    delayMs: options.delayMs,
    shouldFail: options.shouldFail,
    byCredential: options.byCredential,
    throwAfterMs: options.throwAfterMs,
  });
}

/** Close a transport mid-way through a publish, then verify idempotent cleanup. */
export async function closeMidPublish(transport: FakeTransport): Promise<void> {
  await transport.close();
}
