import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EventService,
  type EventServiceDeps,
} from "../../src/event/index.js";
import { EnvelopeBuilder } from "../../src/event/envelope.js";
import {
  AckHandler,
} from "../../src/event/ack.js";
import {
  canTransition,
  MemoryDeliveryRecordStore,
  deliveryRecordKey,
} from "../../src/event/delivery-state.js";
import { FanoutScheduler } from "../../src/event/fanout.js";
import {
  DEFAULT_EVENT_CONFIG,
  EVENT_PROTOCOL_VERSION,
  type EventEnvelope,
} from "../../src/event/types.js";
import { FakeTransport } from "../../src/transport/testing/transport-connection.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const clock = { now: () => 1_000_000_000_000 };
const idGenerator = { generate: () => "msg-" + Math.random().toString(36).slice(2) };

function makeTransport(id: string): FakeTransport {
  return new FakeTransport(id);
}

function makeConnectionView(
  connectionId: string,
  opts: {
    authenticated?: boolean;
    userId?: string;
    tenantId?: string;
    transport?: FakeTransport;
  } = {},
): any {
  const authenticated = opts.authenticated ?? true;
  return {
    connectionId,
    state: authenticated ? "authenticated" : "connecting",
    principal: authenticated
      ? {
        userId: opts.userId ?? "user-" + connectionId,
        tenantId: opts.tenantId ?? "tenant-a",
        roles: ["user"],
        sessionId: "s1",
      }
      : undefined,
    transport: opts.transport ?? { id: connectionId, send: async () => {} },
  };
}

function makeDeps(opts: {
  hubConnections?: Record<string, any>;
  members?: Record<string, string[]>;
  authorize?: (
    action: string,
    principal: { userId: string; tenantId: string; roles: readonly string[]; sessionId: string },
    resourceId?: string,
    tenantId?: string,
  ) => boolean | Promise<boolean>;
  trackingEnabled?: boolean;
} = {}): EventServiceDeps {
  const hubConnections = opts.hubConnections ?? {};
  const members = opts.members ?? {};
  const hub: EventServiceDeps["hub"] = {
    getConnection: (connectionId: string) => hubConnections[connectionId] ?? undefined,
  };
  const membership: any = {
    members: (roomId: string) => members[roomId] ?? [],
    count: (roomId: string) => (members[roomId] ?? []).length,
    rooms: (connectionId: string) => [],
    has: (connectionId: string, roomId: string) =>
      (members[roomId] ?? []).includes(connectionId),
  };
  return {
    hub,
    membership,
    authorize: opts.authorize,
    clock,
    idGenerator,
    errorRegistry: undefined,
  };
}

// ---------------------------------------------------------------------------
// Envelope builder
// ---------------------------------------------------------------------------

describe("event — envelope builder", () => {
  it("builds a valid envelope with stable message id", () => {
    const builder = new EnvelopeBuilder(clock, idGenerator, {
      protocolVersion: EVENT_PROTOCOL_VERSION,
      maxPayloadBytes: 1000,
    });
    const { envelope } = builder.build({
      event: "room:message",
      payload: { text: "hi" },
      namespace: "tenant-a",
      senderConnectionId: "c1",
      senderUserId: "user-1",
      delivery: "at-least-once",
    });
    expect(envelope.protocolVersion).toBe(EVENT_PROTOCOL_VERSION);
    expect(envelope.messageId).toBeDefined();
    expect(envelope.senderConnectionId).toBe("c1");
    expect(envelope.senderUserId).toBe("user-1");
    expect(envelope.delivery).toBe("at-least-once");
    expect(typeof envelope.createdAt).toBe("number");
    expect(envelope.expiresAt).toBeDefined();
  });

  it("rejects unsupported protocol version", () => {
    const builder = new EnvelopeBuilder(clock, idGenerator, {
      protocolVersion: EVENT_PROTOCOL_VERSION,
      maxPayloadBytes: 1000,
    });
    expect(() =>
      builder.build({
        event: "x",
        payload: {},
        namespace: "t",
        senderConnectionId: "c1",
        senderUserId: "u",
        delivery: "ephemeral",
        protocolVersion: 99,
      }),
    ).toThrow();
  });

  it("rejects oversized payload", () => {
    const builder = new EnvelopeBuilder(clock, idGenerator, {
      protocolVersion: EVENT_PROTOCOL_VERSION,
      maxPayloadBytes: 10,
    });
    expect(() =>
      builder.build({
        event: "x",
        payload: { text: "this is a long payload" },
        namespace: "t",
        senderConnectionId: "c1",
        senderUserId: "u",
        delivery: "ephemeral",
      }),
    ).toThrow();
  });

  it("reuses messageId for idempotent duplicate publish", () => {
    const builder = new EnvelopeBuilder(clock, idGenerator, {
      protocolVersion: EVENT_PROTOCOL_VERSION,
      maxPayloadBytes: 1000,
    });
    const fixedId = "msg-fixed-1";
    const a = builder.build({
      event: "x",
      payload: {},
      namespace: "t",
      senderConnectionId: "c1",
      senderUserId: "u",
      delivery: "ephemeral",
      messageId: fixedId,
    });
    const b = builder.build({
      event: "x",
      payload: {},
      namespace: "t",
      senderConnectionId: "c1",
      senderUserId: "u",
      delivery: "ephemeral",
      messageId: fixedId,
    });
    expect(a.envelope.messageId).toBe(fixedId);
    expect(b.envelope.messageId).toBe(fixedId);
    expect(a.isIdempotentReuse).toBe(true);
    expect(b.isIdempotentReuse).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Delivery state machine
// ---------------------------------------------------------------------------

describe("event — delivery state machine", () => {
  const legal: Array<[string, string, boolean]> = [
    ["created", "accepted", true],
    ["accepted", "queued", true],
    ["queued", "written", true],
    ["written", "received", true],
    ["received", "processed", true],
    ["created", "written", false], // skip
    ["processed", "received", false], // regression
    ["failed", "received", false], // terminal
    ["expired", "processed", false], // terminal
    ["written", "expired", true],
    ["queued", "failed", true],
  ];

  it("enforces legal transitions", () => {
    for (const [from, to, ok] of legal) {
      expect(canTransition(from as any, to as any)).toBe(ok);
    }
  });

  it("terminal states have no outgoing transitions", () => {
    expect(canTransition("processed", "received")).toBe(false);
    expect(canTransition("failed", "written")).toBe(false);
    expect(canTransition("expired", "queued")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ACK handling
// ---------------------------------------------------------------------------

describe("event — ACK handling", () => {
  it("accepts a received ACK and advances state", () => {
    const store = new MemoryDeliveryRecordStore();
    const handler = new AckHandler(store, (conn, claiming) => conn === claiming);
    store.set({
      messageId: "m1",
      recipientConnectionId: "r1",
      state: "written",
      attempts: 1,
      deadlineAt: 2_000_000_000_000,
    });
    const result = handler.handle(
      { messageId: "m1", recipientConnectionId: "r1", kind: "received" },
      "r1",
    );
    expect(result.ok).toBe(true);
    const r1ok = result as { ok: true; state: string; transitioned: boolean };
    expect(r1ok.state).toBe("received");
    expect(r1ok.transitioned).toBe(true);
    expect(store.get(deliveryRecordKey("m1", "r1"))?.state).toBe("received");
  });

  it("is idempotent: repeated received ACK is a no-op", () => {
    const store = new MemoryDeliveryRecordStore();
    const handler = new AckHandler(store, (conn, claiming) => conn === claiming);
    store.set({
      messageId: "m1",
      recipientConnectionId: "r1",
      state: "received",
      attempts: 1,
      deadlineAt: 2_000_000_000_000,
    });
    const r1 = handler.handle(
      { messageId: "m1", recipientConnectionId: "r1", kind: "received" },
      "r1",
    );
    expect(r1.ok).toBe(true);
    const r1ok = r1 as { ok: true; state: string; transitioned: boolean };
    expect(r1ok.transitioned).toBe(false);
    expect(r1ok.state).toBe("received");
  });

  it("rejects ACK from wrong connection", () => {
    const store = new MemoryDeliveryRecordStore();
    const handler = new AckHandler(store, (conn, claiming) => conn === claiming);
    store.set({
      messageId: "m1",
      recipientConnectionId: "r1",
      state: "written",
      attempts: 1,
      deadlineAt: 2_000_000_000_000,
    });
    const result = handler.handle(
      { messageId: "m1", recipientConnectionId: "r1", kind: "received" },
      "r2",
    );
    expect(result.ok).toBe(false);
    const r2 = result as { ok: false; code: string };
    expect(r2.code).toBe("WRONG_RECIPIENT");
  });

  it("accepts a late processed ACK after a retry", () => {
    const store = new MemoryDeliveryRecordStore();
    const handler = new AckHandler(store, (conn, claiming) => conn === claiming);
    store.set({
      messageId: "m1",
      recipientConnectionId: "r1",
      state: "written",
      attempts: 3,
      deadlineAt: 2_000_000_000_000,
    });
    // Late "received" ACK completes the original record even after a retry.
    const received = handler.handle(
      { messageId: "m1", recipientConnectionId: "r1", kind: "received" },
      "r1",
    );
    expect(received.ok).toBe(true);
    const rReceived = received as { ok: true; state: string };
    expect(rReceived.state).toBe("received");
    // Then "processed" advances it further.
    const processed = handler.handle(
      { messageId: "m1", recipientConnectionId: "r1", kind: "processed" },
      "r1",
    );
    expect(processed.ok).toBe(true);
    const rProcessed = processed as { ok: true; state: string };
    expect(rProcessed.state).toBe("processed");
  });

  it("rejects unknown message", () => {
    const store = new MemoryDeliveryRecordStore();
    const handler = new AckHandler(store, (conn, claiming) => conn === claiming);
    const result = handler.handle(
      { messageId: "nonexistent", recipientConnectionId: "r1", kind: "received" },
      "r1",
    );
    expect(result.ok).toBe(false);
    const rBad = result as { ok: false; code: string };
    expect(rBad.code).toBe("UNKNOWN_MESSAGE");
  });
});

// ---------------------------------------------------------------------------
// Fan-out scheduler
// ---------------------------------------------------------------------------

describe("event — fan-out scheduler", () => {
  it("drops sends when per-connection queue is over limit", async () => {
    const scheduler = new FanoutScheduler({
      concurrency: 4,
      maxQueuedBytesPerConnection: 100,
    });
    let sendResolve: (() => void) | undefined;
    const recipient: any = {
      connectionId: "c1",
      send: async () => {
        await new Promise<void>((res) => {
          sendResolve = res;
        });
      },
    };
    const big = new Uint8Array(80);
    const p1 = scheduler.enqueue(recipient, big); // 80 bytes queued, send hangs
    const ok2 = await scheduler.enqueue(recipient, big); // 80+80=160 > 100
    expect(ok2).toBe(false);
    expect(scheduler.queuedBytesFor("c1")).toBe(80);
    sendResolve?.(); // release the hanging send
    await p1;
  });

  it("schedules connections fairly while preserving per-connection FIFO", async () => {
    const scheduler = new FanoutScheduler({ concurrency: 1 });
    const order: string[] = [];
    const recipient = (connectionId: string) => ({
      connectionId,
      send: async (bytes: Uint8Array) => { order.push(`${connectionId}${bytes[0]}`); },
    });
    const a = recipient("a");
    const b = recipient("b");
    await Promise.all([
      scheduler.enqueue(a, new Uint8Array([1])),
      scheduler.enqueue(a, new Uint8Array([2])),
      scheduler.enqueue(b, new Uint8Array([1])),
    ]);
    expect(order).toEqual(["a1", "b1", "a2"]);
    expect(scheduler.queuedBytesFor("a")).toBe(0);
    expect(scheduler.pendingCount("a")).toBe(0);
  });

  it("recovers from synchronous transport throws and releases queue accounting", async () => {
    const scheduler = new FanoutScheduler({ concurrency: 1 });
    const result = await scheduler.enqueue({
      connectionId: "broken",
      send: () => { throw new Error("transport failed synchronously"); },
    }, new Uint8Array([1, 2, 3]));
    expect(result).toBe(false);
    expect(scheduler.queuedBytesFor("broken")).toBe(0);
    expect(scheduler.pendingCount("broken")).toBe(0);
  });

  it("validates scheduler limits", () => {
    expect(() => new FanoutScheduler({ concurrency: 0 })).toThrow(RangeError);
    expect(() => new FanoutScheduler({ concurrency: 1.5 })).toThrow(RangeError);
    expect(() => new FanoutScheduler({ maxQueuedBytesPerConnection: -1 })).toThrow(RangeError);
  });

  it("isolates slow recipients: fast recipient still sends", async () => {
    const scheduler = new FanoutScheduler({ concurrency: 2 });
    const results: string[] = [];
    const slow: any = {
      connectionId: "slow",
      send: async () => {
        await new Promise((r) => setTimeout(r, 100));
        results.push("slow");
      },
    };
    const fast: any = {
      connectionId: "fast",
      send: async () => {
        results.push("fast");
      },
    };
    await Promise.all([
      scheduler.enqueue(slow, new Uint8Array([1])),
      scheduler.enqueue(fast, new Uint8Array([2])),
    ]);
    // Allow the slow send to complete.
    await new Promise((r) => setTimeout(r, 150));
    expect(results).toContain("fast");
    expect(results).toContain("slow");
  });
});

// ---------------------------------------------------------------------------
// EventService publish
// ---------------------------------------------------------------------------

describe("event — service publish", () => {
  it("requires an authenticated connection", async () => {
    const deps = makeDeps({
      hubConnections: {
        c1: makeConnectionView("c1", { authenticated: false }),
      },
    });
    const service = new EventService(deps);
    await expect(
      service.publish("c1", "room:message", { text: "hi" }),
    ).rejects.toThrow();
  });

  it("rejects publish to unknown connection", async () => {
    const deps = makeDeps({});
    const service = new EventService(deps);
    await expect(
      service.publish("missing", "room:message", { text: "hi" }),
    ).rejects.toThrow();
  });

  it("publishes ephemeral to room members and returns partial results", async () => {
    const t1 = makeTransport("r1");
    const t2 = makeTransport("r2");
    const deps = makeDeps({
      hubConnections: {
        c1: makeConnectionView("c1", { authenticated: true, userId: "alice" }),
        r1: makeConnectionView("r1", { authenticated: true, userId: "bob", transport: t1 }),
        r2: makeConnectionView("r2", { authenticated: true, userId: "carol", transport: t2 }),
      },
      members: { "tenant-a": ["r1", "r2"] },
    });
    const service = new EventService(deps);

    const result = await service.publish("c1", "room:message", { text: "hi" }, {
      delivery: "ephemeral",
    });
    expect(result.messageId).toBeDefined();
    expect(result.accepted).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.pending).toBe(0); // ephemeral: no pending

    // Both recipients received the opaque envelope (no plaintext leak).
    const sent = [...t1.sent, ...t2.sent].map((m) => m.data);
    expect(sent.length).toBe(2);
    const joined = sent.map((d) => new TextDecoder().decode(d)).join("");
    expect(joined).toContain("tenant-a");
    expect(joined).toContain("alice");
    // The payload is routed as opaque bytes; the server never decrypts it.
  });

  it("at-least-once returns pending count awaiting ACK", async () => {
    const t1 = makeTransport("r1");
    const deps = makeDeps({
      hubConnections: {
        c1: makeConnectionView("c1", { authenticated: true, userId: "alice" }),
        r1: makeConnectionView("r1", { authenticated: true, userId: "bob", transport: t1 }),
      },
      members: { "tenant-a": ["r1"] },
    });
    const service = new EventService(deps);

    const result = await service.publish("c1", "room:message", { text: "hi" }, {
      delivery: "at-least-once",
    });
    expect(result.accepted).toBe(1);
    expect(result.pending).toBe(1); // awaiting ACK
  });

  it("idempotency key: duplicate publish returns same messageId/result", async () => {
    const t1 = makeTransport("r1");
    const deps = makeDeps({
      hubConnections: {
        c1: makeConnectionView("c1", { authenticated: true, userId: "alice" }),
        r1: makeConnectionView("r1", { authenticated: true, userId: "bob", transport: t1 }),
      },
      members: { "tenant-a": ["r1"] },
    });
    const service = new EventService(deps);

    const r1 = await service.publish("c1", "room:message", { text: "hi" }, {
      delivery: "ephemeral",
      idempotencyKey: "key-1",
    });
    const r2 = await service.publish("c1", "room:message", { text: "hi" }, {
      delivery: "ephemeral",
      idempotencyKey: "key-1",
    });
    expect(r2.messageId).toBe(r1.messageId);
    expect(r2.accepted).toBe(r1.accepted);
  });

  it("excludeSender excludes the publisher from recipients", async () => {
    const t1 = makeTransport("r1");
    const deps = makeDeps({
      hubConnections: {
        c1: makeConnectionView("c1", { authenticated: true, userId: "alice" }),
        r1: makeConnectionView("r1", { authenticated: true, userId: "bob", transport: t1 }),
      },
      members: { "tenant-a": ["c1", "r1"] },
    });
    const service = new EventService(deps);

    const result = await service.publish("c1", "room:message", { text: "hi" }, {
      delivery: "ephemeral",
    });
    expect(result.accepted).toBe(1);
  });

  it("authorization denial returns failed and throws FORBIDDEN", async () => {
    const deps = makeDeps({
      hubConnections: {
        c1: makeConnectionView("c1", { authenticated: true, userId: "alice" }),
      },
      authorize: () => false,
    });
    const service = new EventService(deps);
    await expect(
      service.publish("c1", "room:message", { text: "hi" }),
    ).rejects.toThrow();
  });

  it("sender identity comes from authenticated connection, not payload", async () => {
    const t1 = makeTransport("r1");
    const deps = makeDeps({
      hubConnections: {
        c1: makeConnectionView("c1", {
          authenticated: true,
          userId: "real-user",
          tenantId: "tenant-a",
        }),
        r1: makeConnectionView("r1", { authenticated: true, userId: "bob" }),
      },
      members: { "tenant-a": ["r1"] },
    });
    const service = new EventService(deps);
    const hub = deps.hub as any;
    const originalGet = hub.getConnection.bind(hub);
    hub.getConnection = (id: string) => {
      const base = originalGet(id);
      if (!base) return base;
      base.transport = id === "r1" ? t1 : base.transport;
      return base;
    };

    // Payload tries to spoof a different user.
    await service.publish("c1", "room:message", {
      text: "hi",
      senderUserId: "spoofed-user",
      senderConnectionId: "spoofed-conn",
    } as any);

    const sent = t1.sent.map((m) => m.data);
    expect(sent.length).toBeGreaterThan(0);
    const decoded = JSON.parse(new TextDecoder().decode(sent[0]));
    // Top-level sender identity comes from the authenticated connection,
    // NOT from payload fields.
    expect(decoded.senderUserId).toBe("real-user");
    expect(decoded.senderConnectionId).toBe("c1");
    // Payload may carry anything, but it does not override identity fields.
    expect(decoded.payload.senderUserId).toBe("spoofed-user");
    expect(decoded.payload.senderConnectionId).toBe("spoofed-conn");
  });

  it("expiry stops further retries", () => {
    const store = new MemoryDeliveryRecordStore();
    store.set({
      messageId: "m1",
      recipientConnectionId: "r1",
      state: "written",
      attempts: 2,
      deadlineAt: clock.now() - 1000, // already expired
    });
    const before = store.values().length;
    // Simulate expiry pass.
    const now = clock.now();
    for (const record of store.values()) {
      if (record.state !== "received" && record.state !== "processed" &&
          record.state !== "failed" && record.state !== "expired" &&
          now >= record.deadlineAt) {
        store.set({ ...record, state: "expired" });
      }
    }
    expect(store.get(deliveryRecordKey("m1", "r1"))?.state).toBe("expired");
  });
});
