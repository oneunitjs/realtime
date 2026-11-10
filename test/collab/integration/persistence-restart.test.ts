/**
 * Integration: persistence and restart recovery through `MemoryStorage`.
 *
 * Writes are durable in the storage backend; a "restart" is simulated by a new
 * OpLog (fresh module instance) reading the same storage and replaying history.
 * Duplicate op IDs are idempotent when identical, rejected when conflicting.
 */

import { describe, it, expect } from "vitest";
import type { CrdtOperation, VectorClock } from "../../../src/collab/core/types.js";
import {
  deliver,
  makeInsertOp,
  makePrincipal,
  makeScope,
  setupClient,
} from "../../helpers/collab.js";
import { collaboration } from "../../../src/collab/index.js";
import { MemoryStorage } from "../../../src/collab/server/storage.js";

const principal = makePrincipal({
  userId: "alice",
  tenantId: "tenant-a",
  actorId: "alice-device-1",
});

function opsEqual(a: CrdtOperation[], b: CrdtOperation[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((op, i) => JSON.stringify(op) === JSON.stringify(b[i]));
}

function makeModule(storage: MemoryStorage) {
  return collaboration({
    storage,
    authenticate: () => null,
    authorize: async () => true,
  });
}

describe("collab integration — persistence and restart", () => {
  it("recovers document history from storage after a simulated restart", async () => {
    const scope = makeScope({ tenantId: "tenant-a", documentId: "ledger" });
    const storage = new MemoryStorage();

    const module1 = makeModule(storage);
    const alice1 = setupClient(module1, principal);
    await deliver(alice1, "document.open", { documentId: "ledger" });

    const op1 = makeInsertOp({ actorId: "alice-device-1", counter: 1, value: "f" });
    const op2 = makeInsertOp({ actorId: "alice-device-1", counter: 2, value: "s" });
    await deliver(alice1, "operation.push", { documentId: "ledger", operation: op1 });
    await deliver(alice1, "operation.push", { documentId: "ledger", operation: op2 });

    const storageOps = await storage.getOperationsSince(scope, {});
    expect(storageOps).toHaveLength(2);
    expect(opsEqual(storageOps, [op1, op2])).toBe(true);

    const module2 = makeModule(storage);
    const alice2 = setupClient(module2, principal);
    await deliver(alice2, "document.open", { documentId: "ledger" });

    const sync = alice2.lastEmitted("sync.response") as {
      operations: CrdtOperation[];
      head: VectorClock;
    };
    expect(sync.operations).toHaveLength(2);
    expect(opsEqual(sync.operations, [op1, op2])).toBe(true);
    expect(sync.head).toEqual({ "alice-device-1": 2 });
  });

  it("accepts identical duplicate ops idempotently and rejects conflicting duplicates", async () => {
    const storage = new MemoryStorage();
    const module = makeModule(storage);
    const scope = makeScope({ tenantId: "tenant-a", documentId: "doc" });
    const alice = setupClient(module, principal);

    const op = makeInsertOp({ actorId: "alice-device-1", counter: 1, value: "a" });

    await deliver(alice, "operation.push", { documentId: "doc", operation: op });
    expect((alice.lastEmitted("operation.ack") as { opId: unknown }).opId).toBeDefined();

    alice.clearEmitted();
    await deliver(alice, "operation.push", { documentId: "doc", operation: op });
    const dupAck = alice.lastEmitted("operation.ack") as { opId: { actorId: string; counter: number }; head: Record<string, number> };
    expect(dupAck.opId).toEqual({ actorId: "alice-device-1", counter: 1 });

    alice.clearEmitted();
    const conflicting = makeInsertOp({ actorId: "alice-device-1", counter: 1, value: "X" });
    await deliver(alice, "operation.push", { documentId: "doc", operation: conflicting });
    const error = alice.lastEmitted("error") as { code: string };
    expect(error.code).toBe("ACTOR_CONFLICT");

    expect(module.getOpLog().size(scope)).toBe(1);
    expect(module.getOpLog().since(scope, {})[0].value).toBe("a");
  });
});
