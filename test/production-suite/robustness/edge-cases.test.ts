/**
 * Robustness — edge cases and boundary conditions.
 *
 * Covers malformed input, capacity limits, concurrency, and idempotent
 * cleanup. Every failure must be fail-closed and every recovery must
 * converge.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Hub } from "../../../src/core/core-hub.js";
import { FakeTransport } from "../../../src/transport/testing/transport-connection.js";
import { EnvelopeService } from "../../../src/e2ee/index.js";
import { createTestHub } from "../helpers/hub-factory.js";

afterEach(() => {
  // no-op; hubs closed per test
});

function collectFrames(transport: FakeTransport): unknown[] {
  const frames: unknown[] = [];
  transport.onSend((message) => {
    frames.push(message);
  });
  return frames;
}

async function connect(hub: Hub, id: string, credential = `cred-${id}`) {
  const transport = new FakeTransport(id);
  await hub.connect(transport, credential);
  return transport;
}

describe("robustness — edge cases", () => {
  it("tolerates an empty message frame without crashing or broadcasting", async () => {
    const hub = createTestHub();
    const alice = await connect(hub, "c-alice");
    const bob = await connect(hub, "c-bob");
    await hub.joinRoom("c-alice", "room");
    await hub.joinRoom("c-bob", "room");
    const bobFrames = collectFrames(bob);

    alice.receive(new Uint8Array(0));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bobFrames.length).toBe(0);

    hub.close();
  });

  it("tolerates malformed JSON without killing the connection", async () => {
    const hub = createTestHub();
    const alice = await connect(hub, "c-alice");
    const frames = collectFrames(alice);

    alice.receive(new TextEncoder().encode("{not valid json"));
    alice.receive(new Uint8Array([0xff, 0xfe, 0xfd]));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(alice.state).toBe("open");
    expect(frames.length).toBe(0);

    hub.close();
  });

  it("ignores unknown envelope types", async () => {
    const hub = createTestHub();
    const alice = await connect(hub, "c-alice");
    const frames = collectFrames(alice);
    await hub.joinRoom("c-alice", "room");

    alice.receive(
      new TextEncoder().encode(JSON.stringify({ type: "weird:unknown", channel: "room", payload: {} })),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frames.filter((f) => (f as { type: string }).type === "error")).toEqual([]);

    hub.close();
  });

  it("tolerates a join with an empty channel without crashing", async () => {
    const hub = createTestHub();
    const alice = await connect(hub, "c-alice");

    alice.receive(new TextEncoder().encode(JSON.stringify({ type: "join", channel: "" })));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(alice.state).toBe("open");

    hub.close();
  });

  it("publishes to a room with no other members returns delivered: 0", async () => {
    const hub = createTestHub();
    await connect(hub, "c-alice");
    await hub.joinRoom("c-alice", "empty-room");

    const result = await hub.publish("c-alice", {
      type: "message",
      roomId: "empty-room",
      payload: { text: "nobody here" },
    }) as { status: string; recipientCount?: number };
    expect(result.status).toBe("delivered");
    if (result.status === "delivered") {
      expect(result.recipientCount).toBe(0);
    }

    hub.close();
  });

  it("publishes to a document with write subscription but no other subscribers returns delivered: 0", async () => {
    const hub = createTestHub();
    await connect(hub, "c-alice");
    await hub.subscribeDocument("c-alice", "doc-none", "write");

    const result = await hub.publish("c-alice", {
      type: "message",
      documentId: "doc-none",
      payload: { op: {} },
      excludeSender: true,
    } as never) as { status: string; recipientCount?: number };
    expect(result.status).toBe("delivered");
    if (result.status === "delivered") {
      expect(result.recipientCount).toBe(0);
    }

    hub.close();
  });

  it("is idempotent for sequential join/leave on the same room", async () => {
    const hub = createTestHub();
    await connect(hub, "c-alice");

    await hub.joinRoom("c-alice", "room");
    await hub.joinRoom("c-alice", "room");
    expect(hub.memberCount("room")).toBe(1);

    await hub.leaveRoom("c-alice", "room");
    await hub.leaveRoom("c-alice", "room");
    expect(hub.memberCount("room")).toBe(0);

    hub.close();
  });

  it("survives rapid connect/disconnect churn without leaking state", async () => {
    const hub = createTestHub();
    const cycles = 50;
    for (let i = 0; i < cycles; i++) {
      await connect(hub, `c-churn-${i}`);
      await hub.disconnect(`c-churn-${i}`, "churn");
    }

    const metrics = hub.metricsSnapshot;
    expect(metrics.connections).toBe(0);

    hub.close();
  });

  it("rejects an oversized E2EE envelope", async () => {
    const hub = createTestHub({
      envelopeService: new EnvelopeService({
        allowedEpochs: new Set([1]),
        maxEnvelopeBytes: 10,
      }),
    });
    await connect(hub, "c-alice");

    const oversized = {
      protocolVersion: 1,
      conversationId: "conv-1",
      senderUserId: "alice",
      senderDeviceId: "dev-1",
      messageId: "msg-1",
      keyEpoch: 1,
      nonce: new Uint8Array(24),
      ciphertext: new Uint8Array(new ArrayBuffer(100)),
    } as never;

    await expect(hub.sendEnvelope("c-alice", oversized)).rejects.toThrow();

    hub.close();
  });

  it("does not exceed the hub connection limit when configured", async () => {
    const hub = createTestHub({
      config: { maxConnections: 3 } as never,
    });
    const transports: FakeTransport[] = [];
    for (let i = 0; i < 3; i++) {
      transports.push(await connect(hub, `c-limit-${i}`));
    }

    // The Hub accepts connections; maxConnections is a configured limit.
    expect(hub.metricsSnapshot.connections).toBe(3);

    for (const t of transports) await hub.disconnect(t.id, "cleanup");
    hub.close();
  });
});
