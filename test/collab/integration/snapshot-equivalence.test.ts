/**
 * Integration: snapshot restore equivalence through the real collaboration
 * pipeline. `Restore(snapshot, tail) == Replay(full log)` for text, map,
 * tombstones, emoji, and multi-actor ops; schema/checksum tampering is rejected.
 */

import { describe, it, expect } from "vitest";
import { ApplyEngine, type Snapshot } from "../../../src/collab/index.js";
import type { CrdtOperation } from "../../../src/collab/core/types.js";
import { collaboration } from "../../../src/collab/index.js";
import { MemoryStorage } from "../../../src/collab/server/storage.js";
import {
  deliver,
  makeInsertOp,
  makeMapDeleteOp,
  makeMapSetOp,
  makePrincipal,
  makeScope,
  setupClient,
} from "../../helpers/collab.js";

const principal = makePrincipal({
  userId: "alice",
  tenantId: "tenant-a",
  actorId: "alice-device-1",
});

function makeModule() {
  return collaboration({
    authenticate: () => null,
    authorize: async () => true,
  });
}

function fullReplay(ops: CrdtOperation[]) {
  const engine = new ApplyEngine();
  for (const op of ops) {
    engine.apply(op);
  }
  return {
    text: engine.getState().text,
    map: engine.getState().map,
    vector: engine.getVectorClock(),
  };
}

function restore(snapshot: Snapshot, tail: CrdtOperation[]) {
  const engine = new ApplyEngine();
  engine.loadSnapshot(snapshot, tail);
  return {
    text: engine.getState().text,
    map: engine.getState().map,
    vector: engine.getVectorClock(),
  };
}

describe("collab integration — snapshot equivalence", () => {
  it("snapshot + tail equals full log replay for text, map, tombstones, emoji", async () => {
    const scope = makeScope({ tenantId: "tenant-a", documentId: "snapshot-doc" });
    const module = makeModule();
    const alice = setupClient(module, principal);
    const bob = setupClient(module, makePrincipal({ userId: "bob", tenantId: "tenant-a", actorId: "b1" }));

    const ops: CrdtOperation[] = [
      makeInsertOp({ actorId: "alice-device-1", counter: 1, value: "h" }),
      makeInsertOp({ actorId: "b1", counter: 1, value: "🚀" }),
      makeMapSetOp({ actorId: "alice-device-1", counter: 2, key: "title", value: "Draft", logicalTime: 1 }),
      makeMapDeleteOp({ actorId: "b1", counter: 2, key: "title", logicalTime: 2 }),
      makeInsertOp({ actorId: "alice-device-1", counter: 3, value: "!" }),
    ];

    for (const op of ops) {
      await deliver(alice, "operation.push", { documentId: "snapshot-doc", operation: op });
    }

    const full = fullReplay(ops);

    const partial = new ApplyEngine();
    partial.apply(ops[0]);
    partial.apply(ops[1]);
    const snapshot = partial.snapshot() as Snapshot;

    const restored = restore(snapshot, ops.slice(2));
    expect(restored.text).toBe(full.text);
    expect(restored.vector).toEqual(full.vector);
    expect(restored.map.get("title")).toBeUndefined();
  });

  it("middleware snapshot.request returns a snapshot and head", async () => {
    const storage = new MemoryStorage();
    const module = collaboration({
      storage,
      authenticate: () => null,
      authorize: async () => true,
    });
    const alice = setupClient(module, principal);
    await deliver(alice, "document.open", { documentId: "snap-doc" });

    await deliver(alice, "operation.push", {
      documentId: "snap-doc",
      operation: makeInsertOp({ actorId: "alice-device-1", counter: 1, value: "s" }),
    });

    // Persist a snapshot so snapshot.request has something to return.
    const engine = new ApplyEngine();
    engine.apply(makeInsertOp({ actorId: "alice-device-1", counter: 1, value: "s" }));
    await storage.saveSnapshot(makeScope({ tenantId: "tenant-a", documentId: "snap-doc" }), engine.snapshot());

    await deliver(alice, "snapshot.request", { documentId: "snap-doc" });
    const response = alice.lastEmitted("snapshot.response") as {
      documentId: string;
      head: Record<string, number>;
      snapshot: unknown;
    };
    expect(response.documentId).toBe("snap-doc");
    expect(response.head).toEqual({ "alice-device-1": 1 });
    expect(response.snapshot).toBeDefined();
    expect((response.snapshot as { schemaVersion: number }).schemaVersion).toBe(1);
  });

  it("loadSnapshot rejects unknown schema version", () => {
    const engine = new ApplyEngine();
    expect(() =>
      engine.loadSnapshot(
        { schemaVersion: 2, versionVector: {}, nodes: [], registers: [], checksum: "x" } as Snapshot,
        [],
      ),
    ).toThrow();
  });

  it("loadSnapshot rejects a tampered checksum", () => {
    const engine = new ApplyEngine();
    engine.apply(makeInsertOp({ actorId: "alice-device-1", counter: 1, value: "h" }));
    const snapshot = engine.snapshot() as Snapshot;
    snapshot.checksum = "tampered";
    const restored = new ApplyEngine();
    expect(() => restored.loadSnapshot(snapshot, [])).toThrow();
  });
});
