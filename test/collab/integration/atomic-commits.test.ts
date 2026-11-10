/**
 * Integration: atomic commits at the persistence boundary. Accepted operations
 * durably advance the log/head; rejected or conflicting operations leave
 * knownOps, actors, and the vector clock unchanged and are not persisted.
 */

import { describe, it, expect } from "vitest";
import type { CrdtOperation } from "../../../src/collab/core/types.js";
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

describe("collab integration — atomic commits", () => {
  it("accepted operation persists and advances head; rejected op leaves state unchanged", async () => {
    const scope = makeScope({ tenantId: "tenant-a", documentId: "atomic" });
    const module = makeModule();
    const alice = setupClient(module, principal);

    const op1 = makeInsertOp({ actorId: "alice-device-1", counter: 1, value: "a" });
    await deliver(alice, "operation.push", { documentId: "atomic", operation: op1 });
    const ack1 = alice.lastEmitted("operation.ack") as { head: Record<string, number> };
    expect(ack1.head).toEqual({ "alice-device-1": 1 });
    expect(module.getOpLog().size(scope)).toBe(1);

    const headBefore = module.getOpLog().getHead(scope);
    const sizeBefore = module.getOpLog().size(scope);

    await deliver(alice, "operation.push", {
      documentId: "atomic",
      operation: makeInsertOp({ actorId: "victim-device-1", counter: 9, value: "s" }),
    });
    const err = alice.lastEmitted("error") as { code: string; message: string };
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.message).toContain("INVALID_ACTOR");

    alice.clearEmitted();
    await deliver(alice, "operation.push", {
      documentId: "atomic",
      operation: makeInsertOp({ actorId: "alice-device-1", counter: 1, value: "X" }),
    });
    expect((alice.lastEmitted("error") as { code: string }).code).toBe("ACTOR_CONFLICT");

    expect(module.getOpLog().size(scope)).toBe(sizeBefore);
    expect(module.getOpLog().getHead(scope)).toEqual(headBefore);
    expect(module.getOpLog().since(scope, {})[0].value).toBe("a");
  });

  it("valid op followed by duplicate is idempotent at the commit boundary", async () => {
    const scope = makeScope({ tenantId: "tenant-a", documentId: "idem" });
    const module = makeModule();
    const alice = setupClient(module, principal);

    const op = makeInsertOp({ actorId: "alice-device-1", counter: 1, value: "a" });
    await deliver(alice, "operation.push", { documentId: "idem", operation: op });
    alice.clearEmitted();
    await deliver(alice, "operation.push", { documentId: "idem", operation: op });
    const dupAck = alice.lastEmitted("operation.ack") as {
      opId: { actorId: string; counter: number };
    };
    expect(dupAck.opId).toEqual({ actorId: "alice-device-1", counter: 1 });

    expect(module.getOpLog().size(scope)).toBe(1);
    expect(module.getOpLog().since(scope, {})[0].value).toBe("a");
  });
});
