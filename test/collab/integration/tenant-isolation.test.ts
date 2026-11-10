/**
 * Integration: collaboration pipeline over the real `collaboration()` middleware
 * with an in-memory `MemoryStorage`. Tenant isolation is the audit's strongest
 * concern: two tenants may own same-named documents and must never share an
 * operation namespace or sync response.
 */

import { describe, it, expect } from "vitest";
import type { CrdtOperation } from "../../../src/collab/core/types.js";
import {
  createCollabModule,
  deliver,
  makeInsertOp,
  makePrincipal,
  makeScope,
  setupClient,
} from "../../helpers/collab.js";

function tenantAPrincipal() {
  return makePrincipal({ userId: "alice", tenantId: "tenant-a", actorId: "a1" });
}
function tenantBPrincipal() {
  return makePrincipal({ userId: "bob", tenantId: "tenant-b", actorId: "b1" });
}

describe("collab integration — tenant isolation", () => {
  it("never returns another tenant's operations for a same-named document", async () => {
    const { module, storage } = createCollabModule({
      authenticate: () => null,
      authorize: async () => true,
    });

    const scopeA = makeScope({ tenantId: "tenant-a", documentId: "finance" });
    const scopeB = makeScope({ tenantId: "tenant-b", documentId: "finance" });

    const alice = setupClient(module, tenantAPrincipal());
    const bob = setupClient(module, tenantBPrincipal());

    const opA = makeInsertOp({ actorId: "a1", counter: 1, value: "SECRET-A" });
    const opB = makeInsertOp({ actorId: "b1", counter: 1, value: "SECRET-B" });

    await storage.appendOperation(scopeA, opA);
    await storage.appendOperation(scopeB, opB);

    await deliver(alice, "document.open", { documentId: "finance" });
    const syncA = alice.lastEmitted("sync.response") as {
      operations: CrdtOperation[];
      head: Record<string, number>;
      tenantId: string;
    };
    expect(syncA.operations).toHaveLength(1);
    expect(syncA.operations[0]).toBe(opA);
    expect(syncA.head).toEqual({ a1: 1 });
    expect(syncA.tenantId).toBe("tenant-a");
    expect(JSON.stringify(syncA.operations)).not.toContain("SECRET-B");

    await deliver(bob, "document.open", { documentId: "finance" });
    const syncB = bob.lastEmitted("sync.response") as {
      operations: CrdtOperation[];
      head: Record<string, number>;
    };
    expect(syncB.operations).toHaveLength(1);
    expect(syncB.operations[0]).toBe(opB);
    expect(syncB.head).toEqual({ b1: 1 });
    expect(JSON.stringify(syncB.operations)).not.toContain("SECRET-A");

    expect(syncA.head).not.toEqual(syncB.head);
  });

  it("keeps per-tenant vector clocks isolated on subsequent syncs", async () => {
    const { module } = createCollabModule({
      authenticate: () => null,
      authorize: async () => true,
    });

    const scopeA = makeScope({ tenantId: "tenant-a", documentId: "shared" });
    const scopeB = makeScope({ tenantId: "tenant-b", documentId: "shared" });

    const alice = setupClient(module, tenantAPrincipal());
    const bob = setupClient(module, tenantBPrincipal());

    await deliver(alice, "document.open", { documentId: "shared" });
    await deliver(bob, "document.open", { documentId: "shared" });

    await deliver(alice, "operation.push", {
      documentId: "shared",
      operation: makeInsertOp({ actorId: "a1", counter: 1, value: "x" }),
    });
    await deliver(bob, "operation.push", {
      documentId: "shared",
      operation: makeInsertOp({ actorId: "b1", counter: 3, value: "y" }),
    });

    const ackA = alice.lastEmitted("operation.ack") as { head: Record<string, number> };
    const ackB = bob.lastEmitted("operation.ack") as { head: Record<string, number> };
    expect(ackA.head).toEqual({ a1: 1 });
    expect(ackB.head).toEqual({ b1: 3 });

    alice.clearEmitted();
    bob.clearEmitted();
    await deliver(alice, "document.open", { documentId: "shared" });
    await deliver(bob, "document.open", { documentId: "shared" });

    expect(
      (alice.lastEmitted("sync.response") as { head: Record<string, number> }).head,
    ).toEqual({ a1: 1 });
    expect(
      (bob.lastEmitted("sync.response") as { head: Record<string, number> }).head,
    ).toEqual({ b1: 3 });
  });
});
