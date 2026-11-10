/**
 * Integration: malformed frames. The Hub must not crash on invalid JSON,
 * unknown message types, or frames missing required fields; malformed frames
 * are silently dropped and the connection stays open.
 */

import { describe, it, expect } from "vitest";
import { Hub, type HubOptions } from "../../src/core/core-hub.js";
import { DEFAULT_HUB_CONFIG } from "../../src/core/connection/connection.types.js";
import { TestTransport, encodeFrameMsg } from "../helpers/general.js";

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

async function connect(hub: ReturnType<typeof makeHub>, id: string, credential = "cred") {
  const transport = new TestTransport(id);
  await hub.connect(transport, credential);
  return transport;
}

describe("general integration — malformed frames", () => {
  it("drops invalid JSON frames without crashing", async () => {
    const hub = makeHub();
    const transport = await connect(hub, "conn-malformed");

    // Invalid JSON bytes.
    transport.receive(new TextEncoder().encode("{not valid json"));
    // Truncated frame.
    transport.receive(new TextEncoder().encode("{\"type\":\"join\",\"ch"));
    // Empty frame.
    transport.receive(new Uint8Array());

    await new Promise((r) => setTimeout(r, 20));

    expect(transport.closed).toBe(false);
  });

  it("ignores unknown message types and stays open", async () => {
    const hub = makeHub();
    const transport = await connect(hub, "conn-unknown");

    transport.receive(encodeFrameMsg({ type: "completely.unknown.type", payload: {} }));
    transport.receive(encodeFrameMsg({ type: "join" })); // missing channel

    await new Promise((r) => setTimeout(r, 20));

    expect(transport.closed).toBe(false);
  });

  it("rejects publish to a room the sender is not a member of", async () => {
    const hub = makeHub();
    const alice = await connect(hub, "alice");
    const bob = await connect(hub, "bob");

    // Alice publishes to lobby without joining.
    await hub.publish(alice.id, { type: "message", roomId: "lobby", payload: { text: "x" } });

    // Bob should not receive anything.
    expect(bob.sent).toHaveLength(0);
    expect(alice.closed).toBe(false);
  });
});
