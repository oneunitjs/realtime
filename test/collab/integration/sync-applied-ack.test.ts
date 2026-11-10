/**
 * Integration: explicit `sync.applied` acknowledgement. The client's applied
 * frontier only advances when the client acknowledges a sync response; an
 * unacknowledged sync is never treated as applied, so a reconnect re-sends
 * missing operations.
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

describe("collab integration — sync.applied acknowledgement", () => {
  it("unacknowledged sync is re-sent on re-open; frontier advances only on sync.applied", async () => {
    const scope = makeScope({ tenantId: "tenant-a", documentId: "sync-doc" });
    const module = makeModule();
    const alice = setupClient(module, principal);

    await deliver(alice, "document.open", { documentId: "sync-doc" });
    const sync1 = alice.lastEmitted("sync.response") as {
      operations: unknown[];
      head: VectorClock;
    };
    expect(sync1.operations).toHaveLength(0);
    expect(sync1.head).toEqual({});

    const op = makeInsertOp({ actorId: "alice-device-1", counter: 1, value: "f" });
    await deliver(alice, "operation.push", { documentId: "sync-doc", operation: op });
    expect(alice.lastEmitted("operation.ack")).toBeDefined();

    await deliver(alice, "document.open", { documentId: "sync-doc" });
    const sync2 = alice.lastEmitted("sync.response") as { operations: CrdtOperation[]; head: VectorClock };
    expect(sync2.operations).toHaveLength(1);
    expect(sync2.operations[0]).toBe(op);
    const head = sync2.head;

    await deliver(alice, "sync.applied", { documentId: "sync-doc", vector: head });
    expect((alice.lastEmitted("sync.applied.ack") as { documentId: string }).documentId).toBe("sync-doc");

    await deliver(alice, "document.open", { documentId: "sync-doc" });
    const sync3 = alice.lastEmitted("sync.response") as { operations: unknown[] };
    expect(sync3.operations).toHaveLength(0);

    await deliver(alice, "operation.push", { documentId: "sync-doc", operation: makeInsertOp({ actorId: "alice-device-1", counter: 2, value: "g" }) });
    alice.clearEmitted();
    await deliver(alice, "document.open", { documentId: "sync-doc" });
    const sync4 = alice.lastEmitted("sync.response") as { operations: CrdtOperation[] };
    expect(sync4.operations).toHaveLength(1);
    expect(sync4.operations[0].value).toBe("g");
  });
});
