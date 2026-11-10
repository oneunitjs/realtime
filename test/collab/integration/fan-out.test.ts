/**
 * Integration: operation fan-out through the real broadcaster over the
 * `collaboration()` middleware. The sender is ACKed; other subscribers of the
 * same document scope receive the op; non-subscribers and other tenants
 * receive nothing; dropped frames are counted in the broadcast result.
 */

import { describe, it, expect } from "vitest";
import type { CrdtOperation } from "../../../src/collab/core/types.js";
import {
  deliver,
  makeInsertOp,
  makePrincipal,
  makeScope,
  MockSocket,
  setupClient,
} from "../../helpers/collab.js";
import { collaboration } from "../../../src/collab/index.js";
import { MemoryStorage } from "../../../src/collab/server/storage.js";
import type { BroadcastResult } from "../../../src/collab/server/broadcaster.js";

const aliceP = makePrincipal({ userId: "alice", tenantId: "tenant-a", actorId: "alice-device-1" });
const bobP = makePrincipal({ userId: "bob", tenantId: "tenant-a", actorId: "bob-device-1" });
const carolP = makePrincipal({ userId: "carol", tenantId: "tenant-b", actorId: "carol-device-1" });
const scope = makeScope({ tenantId: "tenant-a", documentId: "fanout" });

function makeModule(send: (connectionId: string, envelope: unknown) => Promise<{ status: string }>) {
  return collaboration({
    storage: new MemoryStorage(),
    authenticate: () => null,
    authorize: async () => true,
    send,
  });
}

describe("collab integration — fan-out", () => {
  it("sender is ACKed; same-scope subscribers receive the op; others receive nothing", async () => {
    const sockets = new Map<string, MockSocket>();
    let droppedFor: string | null = null;

    const module = makeModule(async (connectionId, envelope) => {
      const sock = sockets.get(connectionId);
      if (droppedFor === connectionId) {
        droppedFor = null;
        return { status: "dropped" };
      }
      if (sock) sock.receive("operation", envelope);
      return { status: "accepted" };
    });

    const alice = setupClient(module, aliceP);
    const bob = setupClient(module, bobP);
    const carol = setupClient(module, carolP);
    sockets.set(alice.id, alice);
    sockets.set(bob.id, bob);
    sockets.set(carol.id, carol);

    await deliver(alice, "document.open", { documentId: "fanout" });
    await deliver(bob, "document.open", { documentId: "fanout" });
    await deliver(carol, "document.open", { documentId: "fanout-other" });

    const op = makeInsertOp({ actorId: "alice-device-1", counter: 1, value: "f" });
    await deliver(alice, "operation.push", { documentId: "fanout", operation: op });

    const ack = alice.lastEmitted("operation.ack") as {
      opId: { actorId: string; counter: number };
      broadcast: BroadcastResult;
    };
    expect(ack.opId).toEqual({ actorId: "alice-device-1", counter: 1 });
    expect(ack.broadcast.accepted).toBe(1);

    const bobOps = bob.received.filter((r) => r.event === "operation").map((r) => r.payload);
    expect(bobOps).toHaveLength(1);
    expect((bobOps[0] as { operation: CrdtOperation }).operation).toBe(op);

    const carolOps = carol.received.filter((r) => r.event === "operation");
    expect(carolOps).toHaveLength(0);
  });

  it("dropped frames are counted as failed delivery, not delivered", async () => {
    const sockets = new Map<string, MockSocket>();
    const module = makeModule(async (_connectionId, _envelope) => {
      const sock = sockets.get(_connectionId);
      if (sock) sock.receive("operation", _envelope);
      return { status: "dropped" };
    });

    const alice = setupClient(module, aliceP);
    const bob = setupClient(module, bobP);
    sockets.set(alice.id, alice);
    sockets.set(bob.id, bob);

    await deliver(alice, "document.open", { documentId: "fanout" });
    await deliver(bob, "document.open", { documentId: "fanout" });

    const op = makeInsertOp({ actorId: "alice-device-1", counter: 2, value: "d" });
    await deliver(alice, "operation.push", { documentId: "fanout", operation: op });

    const ack = alice.lastEmitted("operation.ack") as { broadcast: BroadcastResult };
    expect(ack.broadcast.dropped).toBe(1);
    expect(ack.broadcast.accepted).toBe(0);
    expect(ack.broadcast.failed).toBe(0);
  });
});
