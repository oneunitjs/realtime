/**
 * Integration: pending-operation deduplication and conflict handling at the
 * storage and apply-engine layers.
 *
 * - Identical duplicate pending op id: idempotent (no state change).
 * - Conflicting payload for the same pending op id: rejected.
 * - Pending capacity: buffer full rejects new not-yet-ready ops.
 */

import { describe, it, expect } from "vitest";
import { ApplyEngine } from "../../../src/collab/index.js";
import type { CrdtOperation } from "../../../src/collab/core/types.js";
import { MemoryStorage } from "../../../src/collab/server/storage.js";
import { makeInsertOp, makeScope } from "../../helpers/collab.js";

describe("collab integration — pending conflicts", () => {
  const scope = makeScope({ tenantId: "tenant-a", documentId: "pending" });

  it("storage: identical duplicate op id is idempotent", async () => {
    const storage = new MemoryStorage();
    const op = makeInsertOp({ actorId: "a", counter: 1, value: "a" });

    const first = await storage.appendOperation(scope, op);
    expect(first).toMatchObject({ accepted: true, duplicate: false, conflict: false });

    const second = await storage.appendOperation(scope, op);
    expect(second).toMatchObject({ accepted: true, duplicate: true, conflict: false });
  });

  it("storage: conflicting payload for the same op id is rejected", async () => {
    const storage = new MemoryStorage();
    const op1 = makeInsertOp({ actorId: "a", counter: 1, value: "A" });
    const op2 = makeInsertOp({ actorId: "a", counter: 1, value: "B" });

    await storage.appendOperation(scope, op1);
    const result = await storage.appendOperation(scope, op2);
    expect(result).toMatchObject({ accepted: false, duplicate: false, conflict: true });
  });

  it("engine: identical duplicate pending op is idempotent", () => {
    const engine = new ApplyEngine();
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
    expect(engine.pendingSize()).toBe(1);
  });

  it("engine: conflicting payload for the same pending op id is rejected", () => {
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

  it("engine: pending capacity enforcement rejects when buffer is full", () => {
    const engine = new ApplyEngine({ maxPendingOps: 2 });
    const readyOp = makeInsertOp({ actorId: "a", counter: 1, value: "a" });
    engine.apply(readyOp); // committed, pending empty

    // Buffer two ops whose deps are on actors that never appear.
    const dep1 = {
      kind: "text.insert",
      opId: { actorId: "z", counter: 1 },
      deps: { missing: 1 },
      after: "ROOT",
      value: "z",
    } as CrdtOperation;
    const dep2 = {
      kind: "text.insert",
      opId: { actorId: "q", counter: 1 },
      deps: { missing2: 1 },
      after: "ROOT",
      value: "y",
    } as CrdtOperation;
    engine.apply(dep1); // buffered (pending = 1)
    engine.apply(dep2); // buffered (pending = 2, at capacity)

    // A third not-ready op exceeds the pending buffer.
    const dep3 = {
      kind: "text.insert",
      opId: { actorId: "r", counter: 1 },
      deps: { missing3: 1 },
      after: "ROOT",
      value: "x",
    } as CrdtOperation;
    const r = engine.apply(dep3);
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") {
      expect(r.code).toBe("PENDING_BUFFER_FULL");
    }
  });
});
