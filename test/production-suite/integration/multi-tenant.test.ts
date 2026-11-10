/**
 * Multi-tenant isolation integration tests.
 *
 * Runs two tenants on a single Hub instance and asserts tenant-scoped access
 * to rooms, documents, and E2EE envelope sender binding.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Hub } from "../../../src/core/core-hub.js";
import { FakeTransport } from "../../../src/transport/testing/transport-connection.js";
import { EnvelopeService, generateDeviceKeys } from "../../../src/e2ee/index.js";
import { createTestHub, connectClient, principalFor, makeAuthProvider } from "../helpers/hub-factory.js";

afterEach(() => {
  // no-op; hubs are closed per test
});

const tenants = {
  "cred-alice": principalFor("alice", "tenant-a"),
  "cred-bob": principalFor("bob", "tenant-b"),
};

function makeTenantHub(): Hub {
  return createTestHub({
    authProvider: makeAuthProvider({ byCredential: tenants }),
    authorize: async (_action, principal, _resourceId, tenantId) => {
      if (tenantId && principal.tenantId !== tenantId) {
        return false;
      }
      return true;
    },
  });
}

function collectFrames(transport: FakeTransport): unknown[] {
  const frames: unknown[] = [];
  transport.onSend((message) => {
    frames.push(message);
  });
  return frames;
}

describe("multi-tenant isolation", () => {
  it("prevents a tenant from publishing to another tenant's room", async () => {
    const hub = makeTenantHub();
    await connectClient(hub, "c-alice", "cred-alice");
    const bob = await connectClient(hub, "c-bob", "cred-bob");
    const bobFrames = collectFrames(bob);

    await hub.joinRoom("c-alice", "room-a");
    await hub.joinRoom("c-bob", "room-b");

    // Alice is not a member of room-b → publish rejected.
    const result = await hub.publish("c-alice", {
      type: "message",
      roomId: "room-b",
      payload: { text: "cross-tenant" },
    });
    expect(result.status).toBe("rejected");

    // Alice can publish to her own room; Bob receives nothing from room-a.
    const ownResult = await hub.publish("c-alice", {
      type: "message",
      roomId: "room-a",
      payload: { text: "hello" },
    });
    expect(ownResult.status).toBe("delivered");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bobFrames.length).toBe(0);

    hub.close();
  });

  it("binds E2EE envelope sender identity to the authenticated principal", async () => {
    const hub = makeTenantHub();
    await connectClient(hub, "c-alice", "cred-alice");
    await connectClient(hub, "c-bob", "cred-bob");
    await hub.joinRoom("c-alice", "conv-1");
    await hub.joinRoom("c-bob", "conv-1");

    const aliceKeys = generateDeviceKeys();
    const bobKeys = generateDeviceKeys();
    const envelopeService = new EnvelopeService({ allowedEpochs: new Set([1]) });

    const envelope = await envelopeService.seal({
      plaintext: new TextEncoder().encode("tenant secret"),
      recipientPublicKey: bobKeys.x25519PublicKey,
      senderX25519KeyPair: {
        publicKey: aliceKeys.x25519PublicKey,
        privateKey: aliceKeys.x25519PrivateKey,
      },
      senderEd25519KeyPair: {
        publicKey: aliceKeys.ed25519PublicKey,
        privateKey: aliceKeys.ed25519PrivateKey,
      },
      conversationId: "conv-1",
      senderUserId: "eve", // does not match authenticated principal "alice"
      senderDeviceId: aliceKeys.deviceId,
      keyEpoch: 1,
      messageId: "msg-1",
    } as never);

    await expect(hub.sendEnvelope("c-alice", envelope)).rejects.toThrow();
    hub.close();
  });

  it("scopes document subscriptions by tenant (tenantId on principal)", async () => {
    const hub = makeTenantHub();
    await connectClient(hub, "c-alice", "cred-alice");
    await connectClient(hub, "c-bob", "cred-bob");

    await hub.subscribeDocument("c-alice", "doc-1", "write");
    await hub.subscribeDocument("c-bob", "doc-2", "read");

    // Each subscription carries the subscribing principal's tenantId.
    expect(hub["documentStore"].getSubscription("doc-1", "c-alice")?.tenantId).toBe("tenant-a");
    expect(hub["documentStore"].getSubscription("doc-2", "c-bob")?.tenantId).toBe("tenant-b");

    // Alice publishes to doc-1; Bob is not subscribed to doc-1 → nothing delivered.
    const result = await hub.publish("c-alice", {
      type: "collab:op",
      documentId: "doc-1",
      payload: { op: {} },
      excludeSender: true,
    } as never);
    expect(result.status).toBe("delivered");
    if (result.status === "delivered") {
      expect(result.recipientCount).toBe(0);
    }

    hub.close();
  });
});
