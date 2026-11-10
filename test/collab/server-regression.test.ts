import { describe, it, expect, vi } from "vitest";
import { OpLog } from "../../src/collab/server/op-log.js";
import { SyncHandler } from "../../src/collab/server/sync-handler.js";
import { ApplyEngine } from "../../src/collab/core/apply.js";
import { RgaSequence } from "../../src/collab/core/rga.js";
import { LwwMap } from "../../src/collab/core/map-lww.js";
import { AllowAllAcl } from "../../src/collab/server/acl.js";
import type {
  CrdtOperation,
  ElementId,
  Snapshot,
  VectorClock,
} from "../../src/collab/core/types.js";
import type { AuthenticatedPrincipal } from "../../src/collab/server/principal.js";

function insertOp(
  actorId: string,
  counter: number,
  value: string,
): CrdtOperation {
  return {
    kind: "text.insert",
    opId: { actorId, counter },
    deps: {},
    after: "ROOT",
    value,
  } as CrdtOperation;
}

const principal: AuthenticatedPrincipal = {
  userId: "alice",
  tenantId: "tenant-a",
  actorId: "alice-device-1",
  roles: ["user"],
};

describe("collab server — document-scope isolation (tenant isolation)", () => {
  it("never returns another tenant's operations for a same-named document", async () => {
    const opLog = new OpLog();

    const scopeA = { tenantId: "tenant-a", documentId: "finance" };
    const scopeB = { tenantId: "tenant-b", documentId: "finance" };

    const opA = insertOp("actor-a", 1, "SECRET-A");
    const opB = insertOp("actor-b", 1, "SECRET-B");

    await opLog.append(scopeA, opA);
    await opLog.append(scopeB, opB);

    const opsA = opLog.since(scopeA, {});
    const opsB = opLog.since(scopeB, {});

    expect(opsA).toHaveLength(1);
    expect(opsA[0]).toBe(opA);
    expect(opsB).toHaveLength(1);
    expect(opsB[0]).toBe(opB);

    // Same actor/counter in different tenants must not collide.
    expect(opLog.getHead(scopeA)).toEqual({ "actor-a": 1 });
    expect(opLog.getHead(scopeB)).toEqual({ "actor-b": 1 });
    expect(JSON.stringify(opsA)).not.toContain("SECRET-B");
    expect(JSON.stringify(opsB)).not.toContain("SECRET-A");
  });

  it("SyncHandler rejects actor-spoofed operations", async () => {
    const opLog = new OpLog();
    const handler = new SyncHandler({ opLog, acl: new AllowAllAcl() });

    const victimOp = insertOp("victim-device-1", 100, "stolen");
    const result = await handler.handleOperation({
      scope: { tenantId: "tenant-a", documentId: "doc" },
      documentId: "doc",
      operation: victimOp,
      connectionId: "conn-1",
      principal,
    });

    expect(result.status).toBe("rejected");
    expect(result.code).toBe("INVALID_ACTOR");
    expect(opLog.since({ tenantId: "tenant-a", documentId: "doc" }, {})).toHaveLength(0);
  });

  it("SyncHandler accepts actor-bound operations", async () => {
    const opLog = new OpLog();
    const handler = new SyncHandler({ opLog, acl: new AllowAllAcl() });

    const op = insertOp("alice-device-1", 1, "a");
    const result = await handler.handleOperation({
      scope: { tenantId: "tenant-a", documentId: "doc" },
      documentId: "doc",
      operation: op,
      connectionId: "conn-1",
      principal,
    });

    expect(result.status).toBe("persisted");
    expect(opLog.since({ tenantId: "tenant-a", documentId: "doc" }, {})).toHaveLength(1);
  });

  it("SyncHandler rejects conflicting duplicate payloads", async () => {
    const opLog = new OpLog();
    const handler = new SyncHandler({ opLog, acl: new AllowAllAcl() });

    const op1 = insertOp("alice-device-1", 1, "a");
    const op2 = insertOp("alice-device-1", 1, "X");

    await handler.handleOperation({
      scope: { tenantId: "tenant-a", documentId: "doc" },
      documentId: "doc",
      operation: op1,
      connectionId: "conn-1",
      principal,
    });

    const result = await handler.handleOperation({
      scope: { tenantId: "tenant-a", documentId: "doc" },
      documentId: "doc",
      operation: op2,
      connectionId: "conn-1",
      principal,
    });

    expect(result.status).toBe("conflict");
    expect(opLog.size({ tenantId: "tenant-a", documentId: "doc" })).toBe(1);
  });
});

describe("collab core — snapshot equivalence (restore == full replay)", () => {
  function fullReplay(ops: CrdtOperation[]): { text: string; vector: VectorClock } {
    const engine = new ApplyEngine();
    for (const op of ops) {
      engine.apply(op);
    }
    return { text: engine.getState().text, vector: engine.getVectorClock() };
  }

  function restore(snapshot: Snapshot, tail: CrdtOperation[]): { text: string; vector: VectorClock } {
    const engine = new ApplyEngine();
    engine.loadSnapshot(snapshot, tail);
    return { text: engine.getState().text, vector: engine.getVectorClock() };
  }

  it("snapshot + tail equals full log replay for text", () => {
    const ops = [
      insertOp("a", 1, "h"),
      insertOp("a", 2, "i"),
      insertOp("b", 1, "!"),
    ];

    const full = fullReplay(ops);
    const snap = new ApplyEngine();
    for (const op of ops.slice(0, 2)) {
      snap.apply(op);
    }
    const restored = restore(snap.snapshot(), ops.slice(2));

    expect(restored.text).toBe(full.text);
    expect(restored.vector).toEqual(full.vector);
    expect(restored.text).toBe("hi!");
  });

  it("restored snapshot renders text and map before tail ops", () => {
    const engine = new ApplyEngine();
    engine.apply({
      kind: "map.set",
      opId: { actorId: "a", counter: 1 },
      deps: {},
      key: "title",
      value: "Project",
      logicalTime: 1,
    } as CrdtOperation);
    engine.apply(insertOp("a", 2, "h"));

    const snap = engine.snapshot();
    const restored = new ApplyEngine();
    restored.loadSnapshot(snap, []);

    expect(restored.getState().text).toBe("h");
    expect(restored.getState().map.get("title")).toBe("Project");
  });

  it("loadSnapshot rejects unknown schema version", () => {
    const engine = new ApplyEngine();
    expect(() =>
      engine.loadSnapshot(
        {
          schemaVersion: 2,
          versionVector: {},
          nodes: [],
          registers: [],
          checksum: "x",
        } as Snapshot,
        [],
      ),
    ).toThrow();
  });

  it("loadSnapshot rejects bad checksum", () => {
    const engine = new ApplyEngine();
    engine.apply(insertOp("a", 1, "h"));
    const snap = engine.snapshot();
    snap.checksum = "tampered";
    const restored = new ApplyEngine();
    expect(() => restored.loadSnapshot(snap, [])).toThrow();
  });
});

describe("collab core — atomic commits", () => {
  it("a failed apply leaves knownOps, counters and vector unchanged", () => {
    const engine = new ApplyEngine();
    // Seed a ready op so apply() reaches commit().
    engine.apply(insertOp("a", 1, "h"));
    const beforeState = engine.getState();
    const beforeKnown = engine.knownSize();
    const beforeVector = engine.getVectorClock();

    // Stub RGA apply to throw mid-commit.
    const originalApply = (engine as any).rga.apply.bind((engine as any).rga);
    (engine as any).rga.apply = () => {
      throw new Error("simulated CRDT apply failure");
    };

    // This op is ready (deps {}, counter 2 > max 1).
    let threw = false;
    try {
      engine.apply(insertOp("a", 2, "i"));
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    // State, knownOps and counters must be exactly as before the failed commit.
    expect(engine.getState().text).toBe(beforeState.text);
    expect(engine.knownSize()).toBe(beforeKnown);
    expect(engine.getVectorClock()).toEqual(beforeVector);

    // Restore.
    (engine as any).rga.apply = originalApply;
  });
});

describe("collab core — RGA Unicode scalar support", () => {
  it("accepts a single emoji (supplementary-plane) insert", () => {
    const rga = new RgaSequence();
    const result = rga.apply({
      kind: "text.insert",
      opId: { actorId: "a", counter: 1 },
      deps: {},
      after: "ROOT",
      value: "🚀",
    } as CrdtOperation);
    expect(result).toBeDefined();
    expect(rga.render()).toBe("🚀");
  });

  it("rejects a multi-character insert", () => {
    const rga = new RgaSequence();
    expect(() =>
      rga.apply({
        kind: "text.insert",
        opId: { actorId: "a", counter: 1 },
        deps: {},
        after: "ROOT",
        value: "ab",
      } as CrdtOperation),
    ).toThrow();
  });
});

describe("collab core — pending operation deduplication", () => {
  it("idempotently accepts identical duplicate pending ops", () => {
    const engine = new ApplyEngine();
    // Buffer op 2 before op 1 (deps on op 1).
    const op1 = {
      kind: "text.insert",
      opId: { actorId: "a", counter: 1 },
      deps: {},
      after: "ROOT",
      value: "a",
    } as CrdtOperation;
    const op2 = {
      kind: "text.insert",
      opId: { actorId: "a", counter: 2 },
      deps: { a: 1 },
      after: { actorId: "a", counter: 1 },
      value: "b",
    } as CrdtOperation;

    engine.apply(op2); // buffered (deps missing)
    const r = engine.apply(op2); // identical duplicate buffered
    expect(r.status).toBe("buffered");

    // Now apply op 1, which should release the buffer.
    engine.apply(op1);
    expect(engine.getState().text).toBe("ab");
  });

  it("rejects conflicting payloads for the same pending op ID", () => {
    const engine = new ApplyEngine();
    const opA = {
      kind: "text.insert",
      opId: { actorId: "a", counter: 1 },
      deps: { z: 5 },
      after: "ROOT",
      value: "A",
    } as CrdtOperation;
    const opB = {
      kind: "text.insert",
      opId: { actorId: "a", counter: 1 },
      deps: { z: 5 },
      after: "ROOT",
      value: "B",
    } as CrdtOperation;

    engine.apply(opA); // buffered
    const r = engine.apply(opB); // conflicting payload
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") {
      expect(r.code).toBe("CONFLICTING_OP_ID");
    }
  });
});
