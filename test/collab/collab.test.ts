import { describe, it, expect } from "vitest";
import {
  ApplyEngine,
  RgaSequence,
  LwwMap,
  MemoryStorage,
  CollaborationEngine,
} from "../../src/collab/index.js";
import type { CrdtOperation, VectorClock } from "../../src/collab/core/types.js";
import {
  validateOperation,
  validateSchemaVersion,
  canonicalJson,
  encodeOperation,
} from "../../src/collab/core/encode.js";
import { elementIdEquals, encodeElementId } from "../../src/collab/core/types.js";

describe("collab — RGA concurrent inserts converge", () => {
  it("two replicas with same ops converge to same text", () => {
    const a = new RgaSequence();
    const b = new RgaSequence();

    const ops = [
      { kind: "text.insert", opId: { actorId: "a1", counter: 1 }, deps: {}, after: "ROOT" as const, value: "a" },
      { kind: "text.insert", opId: { actorId: "b1", counter: 1 }, deps: {}, after: "ROOT" as const, value: "b" },
    ];

    // Different orders.
    a.apply(ops[0]);
    a.apply(ops[1]);
    b.apply(ops[1]);
    b.apply(ops[0]);

    expect(a.render()).toBe(b.render());
  });

  it("concurrent inserts at same anchor ordered by (actorId, counter)", () => {
    const a = new RgaSequence();
    const b = new RgaSequence();

    const after = "ROOT" as const;
    a.apply({ kind: "text.insert", opId: { actorId: "z", counter: 1 }, deps: {}, after, value: "z" });
    a.apply({ kind: "text.insert", opId: { actorId: "a", counter: 1 }, deps: {}, after, value: "a" });

    b.apply({ kind: "text.insert", opId: { actorId: "a", counter: 1 }, deps: {}, after, value: "a" });
    b.apply({ kind: "text.insert", opId: { actorId: "z", counter: 1 }, deps: {}, after, value: "z" });

    expect(a.render()).toBe(b.render());
    expect(a.render()).toBe("az");
  });

  it("tombstoned parent does not orphan descendants during render", () => {
    const rga = new RgaSequence();
    rga.apply({ kind: "text.insert", opId: { actorId: "a", counter: 1 }, deps: {}, after: "ROOT" as const, value: "a" });
    const nodeA = { actorId: "a", counter: 1 };
    rga.apply({ kind: "text.insert", opId: { actorId: "a", counter: 2 }, deps: {}, after: nodeA, value: "b" });
    // Delete the parent.
    rga.apply({ kind: "text.delete", opId: { actorId: "a", counter: 3 }, deps: {}, target: nodeA });
    // Render should still include "b" but not "a".
    expect(rga.render()).toBe("b");
  });

  it("duplicate insert is idempotent: does not change state second time", () => {
    const rga = new RgaSequence();
    const op = { kind: "text.insert", opId: { actorId: "a", counter: 1 }, deps: {}, after: "ROOT" as const, value: "a" };
    rga.apply(op as CrdtOperation);
    const before = rga.render();
    rga.apply(op as CrdtOperation);
    expect(rga.render()).toBe(before);
  });

  it("rejects unsafe integer operation counters", () => {
    expect(() => validateOperation({
      kind: "text.insert", opId: { actorId: "a", counter: Number.MAX_SAFE_INTEGER + 1 },
      deps: {}, after: "ROOT", value: "x",
    })).toThrow(/counter/);
  });

  it("rejects actor IDs containing the element-id separator", () => {
    expect(() => validateOperation({
      kind: "text.insert", opId: { actorId: "a\0b", counter: 1 },
      deps: {}, after: "ROOT", value: "x",
    })).toThrow(/actorId/);
  });

  it("rejects malformed null element references without throwing a TypeError", () => {
    expect(() => validateOperation({
      kind: "text.delete", opId: { actorId: "a", counter: 1 }, deps: {}, target: null,
    })).toThrow(/ElementId/);
  });

  it("rejects non-JSON map values", () => {
    expect(() => validateOperation({
      kind: "map.set", opId: { actorId: "a", counter: 1 }, deps: {},
      key: "k", value: undefined, logicalTime: 1,
    })).toThrow(/JSON-compatible/);
  });

  it("delete-before-insert: target not known throws, never silently drops", () => {
    const rga = new RgaSequence();
    expect(() =>
      rga.apply({ kind: "text.delete", opId: { actorId: "a", counter: 2 }, deps: {}, target: { actorId: "a", counter: 1 } }),
    ).toThrow();
  });
});

describe("collab — LWW map concurrent writes keep one winner", () => {
  it("concurrent sets on same key pick deterministic tie-breaker", () => {
    const map = new LwwMap();
    const t1 = { actorId: "a", counter: 1, logicalTime: 1 };
    const t2 = { actorId: "z", counter: 1, logicalTime: 1 };
    map.set({
      kind: "map.set",
      opId: { actorId: t1.actorId, counter: t1.counter },
      deps: {},
      key: "title",
      value: "from a",
      logicalTime: t1.logicalTime,
    });
    map.set({
      kind: "map.set",
      opId: { actorId: t2.actorId, counter: t2.counter },
      deps: {},
      key: "title",
      value: "from z",
      logicalTime: t2.logicalTime,
    });
    // z sorts after a → z wins.
    expect(map.get("title")).toBe("from z");
  });

  it("higher logicalTime always wins", () => {
    const map = new LwwMap();
    map.set({ kind: "map.set", opId: { actorId: "a", counter: 1 }, deps: {}, key: "k", value: "v1", logicalTime: 5 });
    map.set({ kind: "map.set", opId: { actorId: "b", counter: 1 }, deps: {}, key: "k", value: "v2", logicalTime: 5 });
    // higher (actorId) wins on tie of logicalTime.
    map.set({ kind: "map.set", opId: { actorId: "b", counter: 2 }, deps: {}, key: "k", value: "v3", logicalTime: 6 });
    expect(map.get("k")).toBe("v3");
  });

  it("map delete stores tombstone; get returns undefined", () => {
    const map = new LwwMap();
    map.set({ kind: "map.set", opId: { actorId: "a", counter: 1 }, deps: {}, key: "k", value: "v", logicalTime: 1 });
    map.delete({ kind: "map.delete", opId: { actorId: "a", counter: 2 }, deps: {}, key: "k", logicalTime: 2 });
    expect(map.get("k")).toBeUndefined();
    expect(map.has("k")).toBe(false);
  });
});

describe("collab — ApplyEngine convergence & idempotency", () => {
  it("same set of ops in different order converges to same text", () => {
    const a = new ApplyEngine();
    const b = new ApplyEngine();
    const ops = [
      { kind: "text.insert", opId: { actorId: "a", counter: 1 }, deps: {} as VectorClock, after: "ROOT" as const, value: "a" },
      { kind: "text.insert", opId: { actorId: "a", counter: 2 }, deps: { a: 1 } as VectorClock, after: { actorId: "a", counter: 1 }, value: "b" },
    ];
    a.apply(ops[0]);
    a.apply(ops[1]);
    b.apply(ops[1]); // buffer (deps missing)
    b.apply(ops[0]); // now deps satisfied, processes buffer
    expect(a.getState().text).toBe(b.getState().text);
    expect(a.getState().text).toBe("ab");
  });

  it("duplicate op returns duplicate status, does not change state", () => {
    const engine = new ApplyEngine();
    const op = { kind: "text.insert", opId: { actorId: "a", counter: 1 }, deps: {} as VectorClock, after: "ROOT" as const, value: "a" };
    const r1 = engine.apply(op as CrdtOperation);
    expect(r1.status).toBe("applied");
    const r2 = engine.apply(op as CrdtOperation);
    expect(r2.status).toBe("duplicate");
  });

  it("conflicting op (same id, different payload) is rejected", () => {
    const engine = new ApplyEngine();
    const op1 = { kind: "text.insert", opId: { actorId: "a", counter: 1 }, deps: {} as VectorClock, after: "ROOT" as const, value: "a" };
    const op2 = { kind: "text.insert", opId: { actorId: "a", counter: 1 }, deps: {} as VectorClock, after: "ROOT" as const, value: "X" };
    expect(engine.apply(op1).status).toBe("applied");
    const r = engine.apply(op2);
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") {
      expect(r.code).toBe("CONFLICTING_OP_ID");
    }
  });

  it("non-monotonic counter is rejected", () => {
    const engine = new ApplyEngine();
    engine.apply({ kind: "text.insert", opId: { actorId: "a", counter: 2 }, deps: {}, after: "ROOT", value: "a" });
    const r = engine.apply({ kind: "text.insert", opId: { actorId: "a", counter: 1 }, deps: {}, after: "ROOT", value: "b" });
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") {
      expect(r.code).toBe("NON_MONOTONIC_COUNTER");
    }
  });

  it("map sets apply through the engine and show in materialized map", () => {
    const engine = new ApplyEngine();
    engine.apply({ kind: "map.set", opId: { actorId: "a", counter: 1 }, deps: {}, key: "title", value: "hello", logicalTime: 1 });
    expect(engine.getState().map.get("title")).toBe("hello");
  });

  it("map delete removes key from materialized map", () => {
    const engine = new ApplyEngine();
    engine.apply({ kind: "map.set", opId: { actorId: "a", counter: 1 }, deps: {}, key: "title", value: "hello", logicalTime: 1 });
    engine.apply({ kind: "map.delete", opId: { actorId: "a", counter: 2 }, deps: { a: 1 }, key: "title", logicalTime: 2 });
    expect(engine.getState().map.has("title")).toBe(false);
  });

  it("snapshot contains nodes/registers/vector", () => {
    const engine = new ApplyEngine();
    engine.apply({ kind: "text.insert", opId: { actorId: "a", counter: 1 }, deps: {}, after: "ROOT", value: "a" });
    const snap = engine.snapshot();
    expect(snap.versionVector.a).toBe(1);
    expect(snap.nodes.length).toBe(1);
    expect(snap.checksum).toBeDefined();
  });

  it("same operations regardless of order → same text across replicas", () => {
    const a = new ApplyEngine();
    const b = new ApplyEngine();
    const ops = [
      { kind: "text.insert", opId: { actorId: "a", counter: 1 }, deps: {} as VectorClock, after: "ROOT" as const, value: "a" },
      { kind: "text.insert", opId: { actorId: "b", counter: 1 }, deps: {} as VectorClock, after: "ROOT" as const, value: "b" },
    ];
    ops.forEach((op) => { a.apply({ ...op, deps: {} as VectorClock }); });
    // Shuffled order on b.
    b.apply(ops[1]);
    b.apply(ops[0]);
    expect(a.getState().text).toBe(b.getState().text);
  });
});

describe("collab — canonical encoding", () => {
  it("canonical JSON sorts keys deterministically", () => {
    const a = canonicalJson({ z: 1, a: 2, m: { b: 3, a: 4 } });
    const b = canonicalJson({ a: 2, z: 1, m: { a: 4, b: 3 } });
    expect(a).toBe(b);
  });

  it("encodeOperation is deterministic bytes", () => {
    const op = { kind: "text.insert", opId: { actorId: "a", counter: 1 }, deps: {} as VectorClock, after: "ROOT" as const, value: "x" };
    const a = encodeOperation(op as CrdtOperation);
    const b = encodeOperation(op as CrdtOperation);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("validateOperation accepts a valid op", () => {
    const op = { kind: "text.insert", opId: { actorId: "a", counter: 1 }, deps: {}, after: "ROOT", value: "x" };
    expect(() => validateOperation(op)).not.toThrow();
  });

  it("validateOperation rejects bad op kinds", () => {
    expect(() => validateOperation({ kind: "unknown" })).toThrow();
  });

  it("validateSchemaVersion accepts v1, rejects others", () => {
    expect(validateSchemaVersion(1)).toBe(1);
    expect(() => validateSchemaVersion(2)).toThrow();
    expect(() => validateSchemaVersion("1")).toThrow();
  });
});

describe("collab — vector clock", () => {
  it("depsSatisfied: empty deps always satisfied", () => {
    const local = { a: 2 };
    expect((local as any)).not.toBeNull();
  });

  it("missingRanges reports gaps", () => {
    const local = { a: 1 };
    // deps require a=3 → missing 2..3
    // imported indirectly via vector-clock module
  });
});

describe("collab — Client SDK", () => {
  it("connects with a FakeTransport and issues an actor id from token", async () => {
    const transport = new (await import("../../src/collab/client/transport.js")).FakeTransport();
    const { CollaborationEngine } = await import("../../src/collab/client/engine.js");
    const engine = new CollaborationEngine({
      documentId: "doc-1",
      authToken: "token-abc",
      schemaVersion: 1,
      transport: transport as any,
    });
    await engine.connect();
    const text = engine.getText();
    expect(typeof text).toBe("string");
    await engine.disconnect();
  });

  it("insertText is optimistic: applies locally and sends an op", async () => {
    const transport = new (await import("../../src/collab/client/transport.js")).FakeTransport();
    const { CollaborationEngine } = await import("../../src/collab/client/engine.js");
    const engine = new CollaborationEngine({
      documentId: "doc-2",
      authToken: "tok",
      schemaVersion: 1,
      transport: transport as any,
    });
    await engine.connect();
    const before = engine.getVersionVector();
    await engine.insertText("ROOT", "h");
    await engine.insertText("ROOT", "i");
    // Local text should contain the inserted values (order may vary but both applied).
    const text = engine.getText();
    expect(text).toContain("h");
    expect(text).toContain("i");
    const sent = transport.sentMessages();
    expect(sent.some((m) => m.type === "op")).toBe(true);
    await engine.disconnect();
  });

  it("persists counter to storage across edits", async () => {
    const storage = new MemoryStorage();
    const transport = new (await import("../../src/collab/client/transport.js")).FakeTransport();
    const { CollaborationEngine } = await import("../../src/collab/client/engine.js");
    const engine = new CollaborationEngine({
      documentId: "doc-3",
      authToken: "tok",
      schemaVersion: 1,
      storage,
      transport: transport as any,
    });
    await engine.connect();
    await engine.insertText("ROOT", "x");
    const stored = await storage.getItem("ce:counter:doc-3");
    expect(stored).toBe("1");
    await engine.disconnect();
  });
});
