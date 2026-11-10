/**
 * Integration: authentication timeout. A connection that hangs in the
 * authenticating state beyond `authTimeoutMs` is closed and the connect
 * promise rejects; no connection leak remains.
 */

import { describe, it, expect } from "vitest";
import { AuthenticationTimeoutError } from "../../src/error/index.js";
import { Hub, type HubOptions } from "../../src/core/core-hub.js";
import { DEFAULT_HUB_CONFIG } from "../../src/core/connection/connection.types.js";
import { TestTransport } from "../helpers/general.js";

describe("general integration — auth timeout", () => {
  it("closes the connection and rejects connect when auth exceeds authTimeoutMs", async () => {
    let resolveAuth: (() => void) | null = null;
    const authReady = new Promise<void>((r) => {
      resolveAuth = r;
    });

    const hub = new Hub({
      authProvider: {
        authenticate: async () => {
          await authReady;
          return { userId: "alice", tenantId: "tenant-a", roles: ["user"], sessionId: "s1" };
        },
      },
      authorize: () => true,
      config: { ...DEFAULT_HUB_CONFIG, authTimeoutMs: 50 },
    } as HubOptions);

    const transport = new TestTransport("slow-auth");
    const connectPromise = hub.connect(transport, "cred");

    // Let the auth timeout elapse (50 ms) without resolving authentication.
    await new Promise((r) => setTimeout(r, 150));

    expect(transport.closed).toBe(true);
    await expect(connectPromise).rejects.toBeInstanceOf(AuthenticationTimeoutError);

    // Release the authenticator so it does not hang the process.
    resolveAuth?.();
  });
});
