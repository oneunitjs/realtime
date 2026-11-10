/**
 * Integration: actor binding through the real `collaboration()` middleware.
 * Every operation's `opId.actorId` must equal the actor bound to the
 * authenticated connection; spoofed actors are rejected and never persisted.
 * The middleware surfaces rejections as `VALIDATION_FAILED` (the specific
 * reason is carried in the message).
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

const principal = makePrincipal({
  userId: "alice",
  tenantId: "tenant-a",
  actorId: "alice-device-1",
});

function opFor(actorId: string, counter: number, value: string): CrdtOperation {
  return makeInsertOp({ actorId, counter, value });
}

function makeModule() {
  const { module } = createCollabModule({ principal, authorize: async () => true });
  return module;
}

describe("collab integration — actor binding", () => {
  it("rejects actor-spoofed operations and does not persist them", async () => {
    const module = makeModule();
    const scope = makeScope({ tenantId: "tenant-a", documentId: "doc" });
    const alice = setupClient(module, principal);

    const spoofed = [
      opFor("victim-device-1", 1, "s"),
      opFor("admin-device-1", 1, "s"),
      opFor("", 1, "e"),
      opFor("alice-device-1 ", 1, "w"),
    ];

    for (const op of spoofed) {
      await deliver(alice, "operation.push", { documentId: "doc", operation: op });
      const error = alice.lastEmitted("error") as { code: string; message: string };
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(error.message).toContain("INVALID_ACTOR");
      alice.clearEmitted();
    }

    await deliver(alice, "operation.push", {
      documentId: "doc",
      operation: opFor("alice-device-1", 1, "l"),
    });
    const ack = alice.lastEmitted("operation.ack") as {
      opId: { actorId: string; counter: number };
      head: Record<string, number>;
    };
    expect(ack.opId).toEqual({ actorId: "alice-device-1", counter: 1 });
    expect(ack.head).toEqual({ "alice-device-1": 1 });

    const ops = module.getOpLog().since(scope, {});
    expect(ops).toHaveLength(1);
    expect(ops[0].opId.actorId).toBe("alice-device-1");
    expect(ops[0].value).toBe("l");
  });

  it("rejects malformed operations and leaves the log untouched", async () => {
    const module = makeModule();
    const alice = setupClient(module, principal);

    const badOp = {
      kind: "text.insert",
      opId: { actorId: "alice-device-1", counter: 1 },
      deps: {},
      after: "ROOT",
      value: "ab",
    } as unknown as CrdtOperation;

    await deliver(alice, "operation.push", { documentId: "doc", operation: badOp });
    const error = alice.lastEmitted("error") as { code: string };
    expect(error.code).toBe("VALIDATION_FAILED");

    expect(
      module.getOpLog().size(makeScope({ tenantId: "tenant-a", documentId: "doc" })),
    ).toBe(0);
  });
});
