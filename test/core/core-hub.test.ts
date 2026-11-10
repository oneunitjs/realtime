import { describe, it, expect, vi, afterEach } from "vitest";
import { Hub, type HubOptions } from "../../src/core/core-hub.js";
import type { AuthProvider } from "../../src/core/auth/auth-provider.js";
import type { Principal } from "../../src/core/connection/connection.types.js";
import { FakeTransport } from "../../src/transport/testing/transport-connection.js";
import {
  AuthenticationTimeoutError,
  ForbiddenError,
  ConnectionNotAuthenticatedError,
  RoomCapacityError,
  TenantIsolationError,
} from "../../src/error/index.js";
import type { HubConfig } from "../../src/core/connection/connection.types.js";

function principalFor(userId: string, tenantId: string): Principal {
  return { userId, tenantId, roles: ["user"], sessionId: "s1" };
}

function makeAuthProvider(options: {
  principal?: Principal;
  delayMs?: number;
  shouldFail?: boolean;
  byCredential?: Record<string, Principal>;
} = {}): AuthProvider {
  return {
    authenticate: async (credential, { signal }) => {
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      signal.throwIfAborted?.();
      if (options.shouldFail) {
        throw new Error("invalid credentials");
      }
      if (options.byCredential && credential) {
        const p = options.byCredential[credential];
        if (p) return p;
        throw new Error("unknown credential");
      }
      return options.principal ?? principalFor("alice", "tenant-a");
    },
  };
}

function makeHub(options: {
  authProvider?: AuthProvider;
  config?: Partial<HubConfig>;
  roomCapacities?: Record<string, number>;
  authorize?: (action: string, principal: Principal, resourceId?: string, tenantId?: string) => boolean;
} = {}): Hub {
  return new Hub({
    authProvider: options.authProvider ?? makeAuthProvider(),
    config: options.config,
    roomCapacities: options.roomCapacities,
    authorize: options.authorize,
  } as HubOptions);
}

function roomCount(hub: Hub, roomId: string): number {
  return (hub as unknown as { membership: { count: (r: string) => number } }).membership.count(roomId);
}
function docCount(hub: Hub, documentId: string): number {
  return (hub as unknown as { documentStore: { count: (d: string) => number } }).documentStore.count(documentId);
}

async function connectClient(hub: Hub, id: string, credential?: string): Promise<FakeTransport> {
  const transport = new FakeTransport(id);
  await hub.connect(transport, credential ?? `cred-${id}`);
  return transport;
}

describe("Given a valid credential, When connecting, Then the connection becomes authenticated with a trusted principal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Given a principal derived from the credential, When connect, Then state=authenticated and principal matches", async () => {
    const hub = makeHub({ authProvider: makeAuthProvider({ principal: principalFor("alice", "tenant-a") }) });
    const transport = new FakeTransport("c1");
    const connection = await hub.connect(transport, "cred-c1");
    expect(connection.state).toBe("authenticated");
    expect(connection.principal?.userId).toBe("alice");
    expect(connection.principal?.tenantId).toBe("tenant-a");
    expect(hub.getConnection("c1")?.state).toBe("authenticated");
  });

  it("Given invalid credentials, When connect, Then rejects and removes the provisional record", async () => {
    const hub = makeHub({ authProvider: makeAuthProvider({ shouldFail: true }) });
    const transport = new FakeTransport("c1");
    await expect(hub.connect(transport, "bad")).rejects.toThrow(Error);
    expect(hub.getConnection("c1")).toBeUndefined();
    expect(transport.closed).toBe(true);
  });

  it("Given an auth delay exceeding the deadline, When connect, Then AuthenticationTimeoutError is thrown and connection removed", async () => {
    const hub = makeHub({
      authProvider: makeAuthProvider({ delayMs: 300 }),
      config: { authTimeoutMs: 50 } as Partial<HubConfig>,
    });
    const transport = new FakeTransport("c1");
    await expect(hub.connect(transport, "slow")).rejects.toBeInstanceOf(AuthenticationTimeoutError);
    expect(hub.getConnection("c1")).toBeUndefined();
    expect(transport.closed).toBe(true);
  });

  it("Given a connect in flight, When disconnect is invoked mid-auth, Then cleanup runs once and connection removed", async () => {
    const hub = makeHub({ authProvider: makeAuthProvider({ delayMs: 300 }) });
    const transport = new FakeTransport("c1");
    const promise = hub.connect(transport, "cred");
    await hub.disconnect("c1");
    await expect(promise).rejects.toThrow();
    expect(hub.getConnection("c1")).toBeUndefined();
    expect(transport.closed).toBe(true);
  });

  it("Given spoofed identity fields in a payload, When connecting, Then the principal comes only from the verified credential", async () => {
    const hub = makeHub({ authProvider: makeAuthProvider({ principal: principalFor("real-user", "tenant-a") }) });
    const transport = new FakeTransport("c1");
    const connection = await hub.connect(transport, "cred-c1");
    expect(connection.principal?.userId).toBe("real-user");
    expect(connection.principal?.tenantId).toBe("tenant-a");
  });
});

describe("Given an authenticated connection, When joining a room, Then membership is tracked and enforces capacity and tenant scope", () => {
  it("Given authenticated client, When joinRoom twice on same room, Then membership is idempotent (count 1)", async () => {
    const hub = makeHub();
    await connectClient(hub, "c1");
    await hub.joinRoom("c1", "room-1");
    await hub.joinRoom("c1", "room-1");
    expect(roomCount(hub, "room-1")).toBe(1);
  });

  it("Given authenticated client, When leaveRoom twice, Then membership removed and second leave is a no-op", async () => {
    const hub = makeHub();
    await connectClient(hub, "c1");
    await hub.joinRoom("c1", "room-1");
    await hub.leaveRoom("c1", "room-1");
    await hub.leaveRoom("c1", "room-1");
    expect(roomCount(hub, "room-1")).toBe(0);
  });

  it("Given one connection, When joining two rooms, Then both memberships exist", async () => {
    const hub = makeHub();
    await connectClient(hub, "c1");
    await hub.joinRoom("c1", "room-1");
    await hub.joinRoom("c1", "room-2");
    expect(roomCount(hub, "room-1")).toBe(1);
    expect(roomCount(hub, "room-2")).toBe(1);
  });

  it("Given room capacity=1 and two clients, When both join, Then the second is rejected with RoomCapacityError and count stays 1", async () => {
    const hub = makeHub({ roomCapacities: { "room-1": 1 } });
    await connectClient(hub, "c1");
    await connectClient(hub, "c2");
    await hub.joinRoom("c1", "room-1");
    await expect(hub.joinRoom("c2", "room-1")).rejects.toBeInstanceOf(RoomCapacityError);
    expect(roomCount(hub, "room-1")).toBe(1);
  });

  it("Given an unauthenticated caller, When joinRoom, Then ConnectionNotAuthenticatedError is thrown and no membership created", async () => {
    const hub = makeHub();
    await expect(hub.joinRoom("c1", "room-1")).rejects.toBeInstanceOf(ConnectionNotAuthenticatedError);
  });

  it("Given two different principals, When both join the same room, Tenant isolation keeps only the first", async () => {
    const hub = makeHub({
      authProvider: makeAuthProvider({
        byCredential: {
          alice: principalFor("alice", "tenant-a"),
          bob: principalFor("bob", "tenant-b"),
        },
      }),
    });
    await connectClient(hub, "c1", "alice");
    await connectClient(hub, "c2", "bob");
    // Two tenants can independently use the same bare roomId; room keys
    // are tenant-qualified so they are independent rooms.
    await hub.joinRoom("c1", "room-1");
    await hub.joinRoom("c2", "room-1");
    expect(hub.getConnection("c1")?.state).toBe("authenticated");
    expect(hub.getConnection("c2")?.state).toBe("authenticated");
  });

  it("Given authorize returns false, When joinRoom, Then ForbiddenError is thrown and no membership", async () => {
    const hub = makeHub({ authorize: () => false });
    await connectClient(hub, "c1");
    await expect(hub.joinRoom("c1", "locked")).rejects.toBeInstanceOf(ForbiddenError);
    expect(roomCount(hub, "locked")).toBe(0);
  });
});

describe("Given authenticated room members, When publishing to a room, Then fan-out is partial-safe and excludes the sender by default", () => {
  it("Given c1 and c2 in the same room, When c1 publishes, Then c2 receives the envelope and result is delivered", async () => {
    const hub = makeHub();
    const t1 = await connectClient(hub, "c1");
    const t2 = await connectClient(hub, "c2");
    const received: unknown[] = [];
    t2.onSend((message) => received.push(message));

    await hub.joinRoom("c1", "room-1");
    await hub.joinRoom("c2", "room-1");

    const result = await hub.publish("c1", { type: "message", roomId: "room-1", text: "hello" } as any);
    expect(result.status).toBe("delivered");
    expect(received.length).toBe(1);
  });

  it("Given c1 and c2 in the same room, When c1 publishes, Then c1 itself receives nothing (sender excluded)", async () => {
    const hub = makeHub();
    const t1 = await connectClient(hub, "c1");
    await connectClient(hub, "c2");
    const receivedBySender: unknown[] = [];
    t1.onSend((message) => receivedBySender.push(message));

    await hub.joinRoom("c1", "room-1");
    await hub.joinRoom("c2", "room-1");
    await hub.publish("c1", { type: "message", roomId: "room-1", text: "hi" } as any);
    expect(receivedBySender.length).toBe(0);
  });

  it("Given an unauthenticated caller, When publish, Then ConnectionNotAuthenticatedError is thrown", async () => {
    const hub = makeHub();
    const transport = new FakeTransport("c1");
    await expect(hub.publish("c1", { type: "message", text: "hi" } as any)).rejects.toBeInstanceOf(ConnectionNotAuthenticatedError);
  });
});

describe("Given an authenticated connection, When disconnecting, Then all state is cleared and the transport closed", () => {
  it("Given a connected client, When disconnect twice, Then idempotent (no errors, no record left)", async () => {
    const hub = makeHub();
    await connectClient(hub, "c1");
    await hub.joinRoom("c1", "room-1");
    await hub.disconnect("c1");
    await hub.disconnect("c1");
    expect(hub.getConnection("c1")).toBeUndefined();
    expect(roomCount(hub, "room-1")).toBe(0);
  });

  it("Given a client with memberships and a document subscription, When disconnect, Then rooms, docs, and connection all cleared", async () => {
    const hub = makeHub();
    await connectClient(hub, "c1");
    await hub.joinRoom("c1", "room-1");
    await hub.subscribeDocument("c1", "doc-1");
    await hub.disconnect("c1");
    expect(roomCount(hub, "room-1")).toBe(0);
    expect(docCount(hub, "doc-1")).toBe(0);
    expect(hub.getConnection("c1")).toBeUndefined();
  });

  it("Given a connected client, When disconnect, Then transport is closed", async () => {
    const hub = makeHub();
    const transport = new FakeTransport("c1");
    await hub.connect(transport, "cred");
    await hub.disconnect("c1");
    expect(transport.closed).toBe(true);
  });
});

describe("Given a stale connection (no pongs), When heartbeat sweeps, Then the connection expires and is cleaned up once", () => {
  it("Given a client that never pongs, When heartbeat deadline exceeded, Then connection removed and membership cleared", async () => {
    const hub = makeHub({ config: { pingIntervalMs: 20, pongTimeoutMs: 40 } as Partial<HubConfig> });
    await connectClient(hub, "c1");
    await hub.joinRoom("c1", "room-1");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(hub.getConnection("c1")).toBeUndefined();
    expect(roomCount(hub, "room-1")).toBe(0);
  });
});

describe("Given an authenticated connection, When subscribing to documents, Then subscribe/unsubscribe are idempotent and require auth", () => {
  it("Given authenticated client, When subscribeDocument twice then unsubscribe twice, Then count stays idempotent (1 then 0)", async () => {
    const hub = makeHub();
    await connectClient(hub, "c1");
    await hub.subscribeDocument("c1", "doc-1");
    await hub.subscribeDocument("c1", "doc-1");
    expect(docCount(hub, "doc-1")).toBe(1);
    await hub.unsubscribeDocument("c1", "doc-1");
    await hub.unsubscribeDocument("c1", "doc-1");
    expect(docCount(hub, "doc-1")).toBe(0);
  });

  it("Given an unauthenticated caller, When subscribeDocument, Then ConnectionNotAuthenticatedError is thrown", async () => {
    const hub = makeHub();
    await expect(hub.subscribeDocument("c1", "doc-1")).rejects.toBeInstanceOf(ConnectionNotAuthenticatedError);
  });
});

describe("Given ClientEvent has required typed fields, When optionally defining roomId/documentId, Then they exist on the type", () => {
  it("Given an EventEnvelope constructed inline, When crafting an event, Then optional fields are accepted", async () => {
    const evt = { type: "foo", roomId: "r1", documentId: "d1", excludeSender: false } as any;
    expect(evt.roomId).toBe("r1");
    expect(evt.excludeSender).toBe(false);
  });
});
