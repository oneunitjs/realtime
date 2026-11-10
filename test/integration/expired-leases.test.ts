/**
 * Integration: expired leases. Connections that fall past the pong deadline
 * are swept by the heartbeat timer and disconnected; presence/room/document
 * state is released.
 */

import { describe, it, expect } from "vitest";
import { Hub, type HubOptions } from "../../src/core/core-hub.js";
import { DEFAULT_HUB_CONFIG } from "../../src/core/connection/connection.types.js";
import { TestTransport, encodeFrameMsg } from "../helpers/general.js";

async function connect(hub: Hub, id: string, credential = "cred") {
  const transport = new TestTransport(id);
  await hub.connect(transport, credential);
  return transport;
}

describe("general integration — expired leases", () => {
  it("sweeps and disconnects connections past the pong deadline", async () => {
    const hub = new Hub({
      authProvider: {
        authenticate: async (credential) => ({
          userId: credential ?? "anonymous",
          tenantId: "tenant-a",
          roles: ["user"],
          sessionId: "s1",
        }),
      },
      authorize: () => true,
      config: {
        ...DEFAULT_HUB_CONFIG,
        pingIntervalMs: 20,
        pongTimeoutMs: 30,
      },
    } as HubOptions);

    const transport = await connect(hub, "conn-stale");

    // No inbound messages → lastSeenAt never refreshed. Wait past the
    // pong deadline for the heartbeat sweep to disconnect.
    await new Promise((r) => setTimeout(r, 120));

    expect(transport.closed).toBe(true);
  });

  it("does not disconnect a connection that keeps sending heartbeats", async () => {
    const hub = new Hub({
      authProvider: {
        authenticate: async (credential) => ({
          userId: credential ?? "anonymous",
          tenantId: "tenant-a",
          roles: ["user"],
          sessionId: "s1",
        }),
      },
      authorize: () => true,
      config: {
        ...DEFAULT_HUB_CONFIG,
        pingIntervalMs: 20,
        pongTimeoutMs: 30,
      },
    } as HubOptions);

    const transport = await connect(hub, "conn-alive");

    // Keep sending pings to refresh lastSeenAt past the sweep deadline.
    const ping = encodeFrameMsg({ type: "ping" });
    for (let i = 0; i < 10; i++) {
      transport.receive(ping);
      await new Promise((r) => setTimeout(r, 15));
    }

    expect(transport.closed).toBe(false);
  });
});
