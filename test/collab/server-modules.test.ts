import { describe, it, expect } from "vitest";
import {
  MemoryStorage,
  type CollaborationStorage,
} from "../../src/collab/server/storage.js";
import {
  MemoryDocumentSubscriptions,
} from "../../src/collab/server/subscriptions.js";
import {
  MemoryBroadcaster,
} from "../../src/collab/server/broadcaster.js";
import {
  documentScopeKey,
  parseDocumentScopeKey,
  operationKey,
} from "../../src/collab/server/document-key.js";
import type {
  CrdtOperation,
  VectorClock,
} from "../../src/collab/core/types.js";
import type { DocumentScope } from "../../src/collab/server/document-key.js";

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

describe("server — MemoryDocumentSubscriptions", () => {
  it("tracks bidirectional membership", () => {
    const subs = new MemoryDocumentSubscriptions();
    const scope: DocumentScope = {
      tenantId: "tenant-a",
      documentId: "doc-1",
    };

    subs.subscribe(scope, "conn-1");
    subs.subscribe(scope, "conn-2");

    expect(subs.members(scope)).toEqual(["conn-1", "conn-2"]);

    // Unsubscribing one connection does not affect the other.
    subs.unsubscribe(scope, "conn-1");
    expect(subs.members(scope)).toEqual(["conn-2"]);
  });

  it("removeConnection removes a connection from all documents", () => {
    const subs = new MemoryDocumentSubscriptions();
    const scopeA: DocumentScope = {
      tenantId: "tenant-a",
      documentId: "doc-a",
    };
    const scopeB: DocumentScope = {
      tenantId: "tenant-b",
      documentId: "doc-b",
    };

    subs.subscribe(scopeA, "conn-1");
    subs.subscribe(scopeB, "conn-1");

    subs.removeConnection("conn-1");

    expect(subs.members(scopeA)).toEqual([]);
    expect(subs.members(scopeB)).toEqual([]);
  });

  it("removing last member cleans up the document entry", () => {
    const subs = new MemoryDocumentSubscriptions();
    const scope: DocumentScope = {
      tenantId: "tenant-a",
      documentId: "doc-1",
    };

    subs.subscribe(scope, "conn-1");
    subs.unsubscribe(scope, "conn-1");
    expect(subs.members(scope)).toEqual([]);
  });
});

describe("server — MemoryBroadcaster", () => {
  it("broadcasts to all members except the excluded sender", async () => {
    const subs = new MemoryDocumentSubscriptions();
    const scope: DocumentScope = {
      tenantId: "tenant-a",
      documentId: "doc-1",
    };

    subs.subscribe(scope, "sender");
    subs.subscribe(scope, "recipient-1");
    subs.subscribe(scope, "recipient-2");

    const received: Array<string> = [];
    const send = async (connectionId: string) => {
      received.push(connectionId);
      return { status: "accepted" as const };
    };

    const broadcaster = new MemoryBroadcaster(subs, send);
    const result = await broadcaster.broadcast(
      scope,
      insertOp("actor-1", 1, "x"),
      { excludeConnectionId: "sender" },
    );

    expect(result.recipients).toBe(3);
    expect(result.accepted).toBe(2);
    expect(result.failed).toBe(0);
    expect(received).toEqual(["recipient-1", "recipient-2"]);
  });

  it("records dropped frames separately from accepted ones", async () => {
    const subs = new MemoryDocumentSubscriptions();
    const scope: DocumentScope = {
      tenantId: "tenant-a",
      documentId: "doc-1",
    };

    subs.subscribe(scope, "conn-1");
    subs.subscribe(scope, "conn-2");

    const send = async (connectionId: string) => {
      if (connectionId === "conn-1") {
        return { status: "dropped" as const };
      }
      return { status: "accepted" as const };
    };

    const broadcaster = new MemoryBroadcaster(subs, send);
    const result = await broadcaster.broadcast(scope, insertOp("a", 1, "x"));

    expect(result.accepted).toBe(1);
    expect(result.dropped).toBe(1);
  });

  it("retryPending sends pending outbox entries", async () => {
    let appended: Array<{ id: string; status: string }> = [];
    let markedSent: Array<string> = [];
    let markedFailed: Array<string> = [];

    const outbox = {
      append: async (entry: { id: string; status: string }) => {
        appended.push(entry);
      },
      listPending: async () => [
        {
          id: "entry-1",
          scope: {
            tenantId: "tenant-a",
            documentId: "doc-1",
          },
          operation: insertOp("a", 1, "x"),
          excludeConnectionId: undefined,
          status: "pending",
          attempts: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      markSent: async (id: string) => {
        markedSent.push(id);
      },
      markFailed: async (id: string) => {
        markedFailed.push(id);
      },
    };

    const subs = new MemoryDocumentSubscriptions();
    const scope: DocumentScope = {
      tenantId: "tenant-a",
      documentId: "doc-1",
    };
    subs.subscribe(scope, "recipient-1");

    const send = async () => ({ status: "accepted" as const });
    const broadcaster = new MemoryBroadcaster(subs, send, outbox as any);

    await broadcaster.retryPending();

    expect(markedSent).toContain("entry-1");
    expect(markedFailed).toEqual([]);
  });
});

describe("server — MemoryStorage snapshot compaction", () => {
  it("saveSnapshot and getSnapshot round-trip", async () => {
    const storage = new MemoryStorage();
    const scope: DocumentScope = {
      tenantId: "tenant-a",
      documentId: "doc-1",
    };

    // Initially no snapshot.
    expect(await storage.getSnapshot(scope)).toBeNull();

    const snapshot = {
      schemaVersion: 1,
      nodes: [],
      registers: [],
      vector: { a: 5 },
    };

    await storage.saveSnapshot(scope, snapshot);
    const loaded = await storage.getSnapshot(scope);
    expect(loaded).toEqual(snapshot);
  });

  it("is scoped by tenant and document", async () => {
    const storage = new MemoryStorage();
    const scopeA: DocumentScope = {
      tenantId: "tenant-a",
      documentId: "doc-1",
    };
    const scopeB: DocumentScope = {
      tenantId: "tenant-b",
      documentId: "doc-1",
    };

    await storage.saveSnapshot(scopeA, { tenant: "a" });
    expect(await storage.getSnapshot(scopeA)).toEqual({ tenant: "a" });
    expect(await storage.getSnapshot(scopeB)).toBeNull();
  });
});

describe("server — documentScopeKey and operationKey", () => {
  it("produces stable composite keys", () => {
    const key1 = documentScopeKey({
      tenantId: "tenant-a",
      documentId: "doc-1",
    });
    const key2 = documentScopeKey({
      tenantId: "tenant-a",
      documentId: "doc-1",
    });
    expect(key1).toBe(key2);
    expect(key1).toBe(JSON.stringify(["tenant-a", "doc-1"]));
  });

  it("distinguishes different tenants with same document name", () => {
    const keyA = documentScopeKey({
      tenantId: "tenant-a",
      documentId: "finance",
    });
    const keyB = documentScopeKey({
      tenantId: "tenant-b",
      documentId: "finance",
    });
    expect(keyA).not.toBe(keyB);
  });

  it("round-trips composite document keys and rejects malformed decoded values", () => {
    const scope = { tenantId: "tenant:with:delimiters", documentId: "doc:1" };
    expect(parseDocumentScopeKey(documentScopeKey(scope))).toEqual(scope);
    expect(() => parseDocumentScopeKey(JSON.stringify([1, "doc"]))).toThrow();
    expect(() => parseDocumentScopeKey(JSON.stringify(["tenant", null]))).toThrow();
  });

  it("produces stable operation keys", () => {
    const key1 = operationKey("actor-1", 5);
    const key2 = operationKey("actor-1", 5);
    expect(key1).toBe(key2);
    expect(key1).toBe(JSON.stringify(["actor-1", 5]));
  });

  it("distinguishes different counters", () => {
    expect(operationKey("actor-1", 1)).not.toBe(
      operationKey("actor-1", 2),
    );
  });

  it("rejects invalid document scopes", () => {
    expect(() =>
      documentScopeKey({ tenantId: "", documentId: "doc" } as any),
    ).toThrow();
    expect(() =>
      documentScopeKey({ tenantId: "t", documentId: "" } as any),
    ).toThrow();
  });

  it("rejects invalid operation keys", () => {
    expect(() => operationKey("", 1)).toThrow();
    expect(() => operationKey("a", -1)).toThrow();
  });
});

describe("server — MemoryStorage append idempotency and conflict", () => {
  it("accepts, detects duplicates, and rejects conflicts", async () => {
    const storage = new MemoryStorage();
    const scope: DocumentScope = {
      tenantId: "tenant-a",
      documentId: "doc-1",
    };

    const op1 = insertOp("actor-1", 1, "a");
    const op2 = insertOp("actor-1", 1, "a"); // identical duplicate
    const op3 = insertOp("actor-1", 1, "x"); // conflicting payload

    const r1 = await storage.appendOperation(scope, op1);
    expect(r1.accepted).toBe(true);
    expect(r1.duplicate).toBe(false);
    expect(r1.conflict).toBe(false);

    const r2 = await storage.appendOperation(scope, op2);
    expect(r2.accepted).toBe(true);
    expect(r2.duplicate).toBe(true);
    expect(r2.conflict).toBe(false);

    const r3 = await storage.appendOperation(scope, op3);
    expect(r3.accepted).toBe(false);
    expect(r3.conflict).toBe(true);
  });

  it("same actor/counter in different tenants does not collide", async () => {
    const storage = new MemoryStorage();
    const scopeA: DocumentScope = {
      tenantId: "tenant-a",
      documentId: "finance",
    };
    const scopeB: DocumentScope = {
      tenantId: "tenant-b",
      documentId: "finance",
    };

    const op = insertOp("actor-1", 1, "value");

    const r1 = await storage.appendOperation(scopeA, op);
    const r2 = await storage.appendOperation(scopeB, op);

    expect(r1.accepted).toBe(true);
    expect(r2.accepted).toBe(true);
    // Both accepted because scopes differ.
  });
});
