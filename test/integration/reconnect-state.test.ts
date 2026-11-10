/**
 * Integration: reconnect state. When a connection disconnects and reconnects,
 * the new connection is authenticated fresh, old room memberships / document
 * subscriptions are released, and no state leaks from the previous session.
 */

import { describe, it, expect } from "vitest";
import { Hub, type HubOptions } from "../../src/core/core-hub.js";
import { DEFAULT_HUB_CONFIG } from "../../src/core/connection/connection.types.js";
import { TestTransport } from "../helpers/general.js";

function makeHub() {
  return new Hub({
    authProvider: {
      authenticate: async (credential) => ({
        userId: credential ?? "anonymous",
        tenantId: "tenant-a",
        roles: ["user"],
        sessionId: "s1",
      }),
    },
    authorize: () => true,
    config: { ...DEFAULT_HUB_CONFIG },
  } as HubOptions);
}

describe("general integration — reconnect state", () => {
  it("releases room membership on disconnect; reconnect starts fresh", async () => {
    const hub = makeHub();

    const a1 = new TestTransport("conn-a1");
    const a2 = new TestTransport("conn-a2");
    await hub.connect(a1, "cred");
    await hub.connect(a2, "cred");

    await hub.joinRoom("conn-a1", "lobby");
    await hub.joinRoom("conn-a2", "lobby");

    const result = await hub.publish("conn-a1", {
      type: "message",
      roomId: "lobby",
      payload: { text: "hi" },
    });
    expect(result.status).toBe("delivered");
    expect(a2.sent.length).toBe(1);

    await hub.disconnect("conn-a1");
    expect(a1.closed).toBe(true);

    a2.sent.length = 0;
    const result2 = await hub.publish("conn-a2", {
      type: "message",
      roomId: "lobby",
      payload: { text: "hi2" },
    });
    expect(result2.status).toBe("delivered");
    expect(a2.sent.length).toBe(0);

    const b1 = new TestTransport("conn-b1");
    await hub.connect(b1, "cred");
    await hub.joinRoom("conn-b1", "lobby");

    a2.sent.length = 0;
    const result3 = await hub.publish("conn-b1", {
      type: "message",
      roomId: "lobby",
      payload: { text: "hi3" },
    });
    expect(result3.status).toBe("delivered");
    expect(a2.sent.length).toBe(1);
  });

  it("releases document subscription on disconnect", async () => {
    const hub = makeHub();

    const a1 = new TestTransport("conn-a1");
    const a2 = new TestTransport("conn-a2");
    await hub.connect(a1, "cred");
    await hub.connect(a2, "cred");

    await hub.subscribeDocument("conn-a1", "doc-1", "write");
    await hub.subscribeDocument("conn-a2", "doc-1", "write");

    const result = await hub.publish("conn-a1", {
      type: "message",
      documentId: "doc-1",
      payload: { text: "x" },
    });
    expect(result.status).toBe("delivered");
    expect(a2.sent.length).toBe(1);

    await hub.disconnect("conn-a1");
    a2.sent.length = 0;
    const result2 = await hub.publish("conn-a2", {
      type: "message",
      documentId: "doc-1",
      payload: { text: "y" },
    });
    expect(result2.status).toBe("delivered");
    expect(a2.sent.length).toBe(1);
  });
});
