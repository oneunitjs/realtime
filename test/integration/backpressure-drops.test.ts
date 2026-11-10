/**
 * Integration: backpressure drops. When a recipient transport reports
 * `dropped` (uWS backpressure limit), the Hub/router counts it as a failed
 * delivery rather than a delivered one, and healthy recipients are unaffected.
 */

import { describe, it, expect } from "vitest";
import { makeHub, connectClient, DroppingTransport } from "../helpers/general.js";

describe("general integration — backpressure drops", () => {
  it("counts a dropped recipient send as failed, not delivered", async () => {
    const hub = makeHub({ authorize: () => true });

    const alice = await connectClient(hub, "alice");
    const bob = new DroppingTransport("bob");
    await hub.connect(bob, "cred");

    await hub.joinRoom("alice", "lobby");
    await hub.joinRoom("bob", "lobby");

    const result = await hub.publish(alice.id, {
      type: "message",
      roomId: "lobby",
      payload: { text: "hi" },
    });

    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.delivered).toBe(0);
      expect(result.failed).toBe(1);
    }

    // The dropping transport never accepted the bytes.
    expect(bob.sent).toHaveLength(0);
  });
});
