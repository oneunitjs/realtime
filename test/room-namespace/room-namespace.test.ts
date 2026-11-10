import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MembershipManager,
} from "../../src/room-namespace/membership-manager.js";
import {
  RoomManager,
} from "../../src/room-namespace/room-manager.js";
import {
  EncryptionGate,
} from "../../src/room-namespace/encryption-gate.js";
import {
  RoomNamespaceRouter,
  type OnPresenceUpdate,
  type OnEventPublish,
  type OnFanout,
} from "../../src/room-namespace/router.js";
import type {
  NamespaceRecord,
  RoomRecord,
  RoomNamespaceStore,
  Membership,
  AuthorizeJoin,
  AuthorizePublish,
} from "../../src/room-namespace/types.js";
import { encodeRoomKey } from "../../src/room-namespace/room-key.js";

// ---------------------------------------------------------------------------
// In-memory store test double
// ---------------------------------------------------------------------------

class TestStore implements RoomNamespaceStore {
  private namespaces = new Map<string, NamespaceRecord>();
  private rooms = new Map<string, RoomRecord>();
  private memberships = new Map<string, Membership[]>(); // roomKey -> memberships

  getNamespace(tenantId: string, namespaceId: string): Promise<NamespaceRecord | null> {
    const key = `${tenantId}:${namespaceId}`;
    return Promise.resolve(this.namespaces.get(key) ?? null);
  }
  createNamespace(record: NamespaceRecord): Promise<void> {
    const key = `${record.tenantId}:${record.namespaceId}`;
    this.namespaces.set(key, record);
    return Promise.resolve();
  }
  deleteNamespace(tenantId: string, namespaceId: string): Promise<void> {
    this.namespaces.delete(`${tenantId}:${namespaceId}`);
    return Promise.resolve();
  }
  listNamespaces(tenantId: string): Promise<NamespaceRecord[]> {
    return Promise.resolve(
      [...this.namespaces.values()].filter((n) => n.tenantId === tenantId),
    );
  }

  getRoom(roomKey: string): Promise<RoomRecord | null> {
    return Promise.resolve(this.rooms.get(roomKey) ?? null);
  }
  createRoom(record: RoomRecord): Promise<void> {
    this.rooms.set(encodeRoomKey(record.tenantId, record.namespaceId, record.roomId), record);
    return Promise.resolve();
  }
  deleteRoom(roomKey: string): Promise<void> {
    this.rooms.delete(roomKey);
    return Promise.resolve();
  }
  listRooms(tenantId: string, namespaceId: string): Promise<RoomRecord[]> {
    return Promise.resolve(
      [...this.rooms.values()].filter(
        (r) => r.tenantId === tenantId && r.namespaceId === namespaceId,
      ),
    );
  }

  getMembership(roomKey: string, connectionId: string): Promise<Membership | null> {
    const ms = this.memberships.get(roomKey) ?? [];
    return Promise.resolve(ms.find((m) => m.connectionId === connectionId) ?? null);
  }
  getMembers(roomKey: string): Promise<Membership[]> {
    return Promise.resolve(this.memberships.get(roomKey) ?? []);
  }
  getMemberCount(roomKey: string): Promise<number> {
    return Promise.resolve((this.memberships.get(roomKey) ?? []).length);
  }
  getConnectionsForUser(userId: string, tenantId: string): Promise<string[]> {
    const result: string[] = [];
    for (const ms of this.memberships.values()) {
      for (const m of ms) {
        if (m.userId === userId) result.push(m.connectionId);
      }
    }
    return Promise.resolve(result);
  }
  addMembership(membership: Membership): Promise<void> {
    const ms = this.memberships.get(membership.roomKey) ?? [];
    if (!ms.some((m) => m.connectionId === membership.connectionId)) {
      ms.push(membership);
      this.memberships.set(membership.roomKey, ms);
    }
    return Promise.resolve();
  }
  removeMembership(roomKey: string, connectionId: string): Promise<void> {
    const ms = this.memberships.get(roomKey) ?? [];
    this.memberships.set(
      roomKey,
      ms.filter((m) => m.connectionId !== connectionId),
    );
    return Promise.resolve();
  }
  removeAllMembershipsForConnection(connectionId: string): Promise<void> {
    for (const [rk, ms] of this.memberships) {
      this.memberships.set(
        rk,
        ms.filter((m) => m.connectionId !== connectionId),
      );
    }
    return Promise.resolve();
  }
  getRoomsForConnection(connectionId: string): Promise<string[]> {
    const result: string[] = [];
    for (const [rk, ms] of this.memberships) {
      if (ms.some((m) => m.connectionId === connectionId)) result.push(rk);
    }
    return Promise.resolve(result);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeRoom = (overrides: Partial<RoomRecord> = {}): RoomRecord => ({
  tenantId: "tenant-1",
  namespaceId: "ns-1",
  roomId: "room-1",
  maxMembers: 10,
  encryptionPolicy: "disabled",
  ...overrides,
});

const makePrincipal = (userId = "user-1", tenantId = "tenant-1") => ({
  userId,
  tenantId,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("room-namespace — TestStore", () => {
  it("round-trips namespace and room records", async () => {
    const store = new TestStore();
    await store.createNamespace({ tenantId: "t", namespaceId: "n", policyId: "p" });
    const ns = await store.getNamespace("t", "n");
    expect(ns?.namespaceId).toBe("n");

    await store.createRoom(makeRoom({ tenantId: "t", namespaceId: "n", roomId: "r1" }));
    const room = await store.getRoom(encodeRoomKey("t", "n", "r1"));
    expect(room?.roomId).toBe("r1");
  });
});

describe("room-namespace — MembershipManager", () => {
  let store: TestStore;
  let mgr: MembershipManager;

  beforeEach(() => {
    store = new TestStore();
    mgr = new MembershipManager(store);
  });

  it("joins a connection to a room and returns member count", async () => {
    await store.createRoom(makeRoom());
    const result = await mgr.join(
      makePrincipal(),
      "conn-1",
      "tenant-1",
      "ns-1",
      "room-1",
      {
        authorizeJoin: async () => true,
        roomRecord: makeRoom(),
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.memberCount).toBe(1);
      expect(result.roomKey).toBe(encodeRoomKey("tenant-1", "ns-1", "room-1"));
    }
  });

  it("rejects unauthorized joins", async () => {
    await store.createRoom(makeRoom());
    const result = await mgr.join(
      makePrincipal(),
      "conn-1",
      "tenant-1",
      "ns-1",
      "room-1",
      {
        authorizeJoin: async () => false,
        roomRecord: makeRoom(),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNAUTHORIZED_JOIN");
  });

  it("enforces room capacity", async () => {
    const room = makeRoom({ maxMembers: 1 });
    await store.createRoom(room);
    await mgr.join(makePrincipal("user-1"), "conn-1", "tenant-1", "ns-1", "room-1", {
      authorizeJoin: async () => true,
      roomRecord: room,
    });
    const result = await mgr.join(makePrincipal("user-2"), "conn-2", "tenant-1", "ns-1", "room-1", {
      authorizeJoin: async () => true,
      roomRecord: room,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ROOM_FULL");
  });

  it("allows idempotent re-join for same connection", async () => {
    await store.createRoom(makeRoom());
    const r1 = await mgr.join(makePrincipal(), "conn-1", "tenant-1", "ns-1", "room-1", {
      authorizeJoin: async () => true,
      roomRecord: makeRoom(),
    });
    expect(r1.ok).toBe(true);
    const r2 = await mgr.join(makePrincipal(), "conn-1", "tenant-1", "ns-1", "room-1", {
      authorizeJoin: async () => true,
      roomRecord: makeRoom(),
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.memberCount).toBe(1);
  });

  it("leaves a room and returns updated count", async () => {
    await store.createRoom(makeRoom());
    await mgr.join(makePrincipal(), "conn-1", "tenant-1", "ns-1", "room-1", {
      authorizeJoin: async () => true,
      roomRecord: makeRoom(),
    });
    const result = await mgr.leave("conn-1", encodeRoomKey("tenant-1", "ns-1", "room-1"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.memberCount).toBe(0);
  });

  it("disconnect removes all memberships for a connection", async () => {
    await store.createRoom(makeRoom());
    await store.createRoom(makeRoom({ roomId: "room-2" }));
    await mgr.join(makePrincipal(), "conn-1", "tenant-1", "ns-1", "room-1", {
      authorizeJoin: async () => true,
      roomRecord: makeRoom(),
    });
    await mgr.join(makePrincipal(), "conn-1", "tenant-1", "ns-1", "room-2", {
      authorizeJoin: async () => true,
      roomRecord: makeRoom({ roomId: "room-2" }),
    });
    await mgr.disconnect("conn-1");
    expect(await store.getMemberCount(encodeRoomKey("tenant-1", "ns-1", "room-1"))).toBe(0);
    expect(await store.getMemberCount(encodeRoomKey("tenant-1", "ns-1", "room-2"))).toBe(0);
  });
});

describe("room-namespace — RoomManager", () => {
  let store: TestStore;
  let mgr: RoomManager;

  beforeEach(() => {
    store = new TestStore();
    mgr = new RoomManager(store);
  });

  it("creates and retrieves a room", async () => {
    const room = makeRoom({ roomId: "alpha" });
    await mgr.createRoom(room);
    const fetched = await mgr.getRoom(encodeRoomKey("tenant-1", "ns-1", "alpha"));
    expect(fetched?.roomId).toBe("alpha");
  });

  it("rejects duplicate room creation", async () => {
    await mgr.createRoom(makeRoom({ roomId: "alpha" }));
    await expect(mgr.createRoom(makeRoom({ roomId: "alpha" }))).rejects.toThrow(
      /already exists/,
    );
  });

  it("refuses to delete a room with members", async () => {
    await mgr.createRoom(makeRoom({ roomId: "alpha" }));
    await store.addMembership({
      roomKey: encodeRoomKey("tenant-1", "ns-1", "alpha"),
      connectionId: "conn-1",
      userId: "user-1",
      joinedAt: Date.now(),
    });
    await expect(
      mgr.deleteRoom("tenant-1", "ns-1", "alpha"),
    ).rejects.toThrow(/members still joined/);
  });

  it("updates encryption policy", async () => {
    await mgr.createRoom(makeRoom({ roomId: "alpha" }));
    await mgr.setEncryptionPolicy("tenant-1", "ns-1", "alpha", "required");
    const policy = await mgr.getEncryptionPolicy("tenant-1", "ns-1", "alpha");
    expect(policy).toBe("required");
  });
});

describe("room-namespace — EncryptionGate", () => {
  let gate: EncryptionGate;

  beforeEach(() => {
    gate = new EncryptionGate();
  });

  const rk = encodeRoomKey("tenant-1", "ns-1", "room-1");

  it("allows join when policy is disabled", async () => {
    const result = await gate.checkJoin(rk, "disabled", false);
    expect(result.allowed).toBe(true);
  });

  it("blocks join when policy is required and no current key", async () => {
    const result = await gate.checkJoin(rk, "required", false);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.error?.code).toBe("ENCRYPTION_REQUIRED");
  });

  it("allows join when policy is required and has current key", async () => {
    const result = await gate.checkJoin(rk, "required", true);
    expect(result.allowed).toBe(true);
  });

  it("blocks plaintext publish when policy is required", async () => {
    const result = await gate.checkPublish(rk, "required", "plaintext", true);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.error?.code).toBe("ENCRYPTION_REQUIRED");
  });

  it("allows ciphertext publish when policy is required", async () => {
    const result = await gate.checkPublish(
      rk,
      "required",
      { type: "e2ee", ciphertext: "abc" },
      true,
    );
    expect(result.allowed).toBe(true);
  });

  it("tracks and advances key epoch per room", () => {
    expect(gate.getEpoch(rk)).toBe(0);
    gate.advanceEpoch(rk);
    expect(gate.getEpoch(rk)).toBe(1);
    gate.advanceEpoch(rk);
    expect(gate.getEpoch(rk)).toBe(2);
  });
});

describe("room-namespace — RoomNamespaceRouter", () => {
  let store: TestStore;
  let router: RoomNamespaceRouter;
  let authorizeJoinCalls: Array<{ userId: string; roomKey: string }>;
  let authorizePublishCalls: Array<{ userId: string; roomKey: string }>;
  let presenceCalls: Array<{ userId: string; status: string; roomKey?: string }>;
  let eventCalls: Array<{ roomKey: string; event: { type: string; data: unknown } }>;
  let fanoutCalls: Array<{ roomKey: string; message: unknown; includeConnectionIds?: string[] }>;

  beforeEach(() => {
    store = new TestStore();
    store.createNamespace({ tenantId: "tenant-1", namespaceId: "ns-1", policyId: "p" });
    store.createRoom(makeRoom({ roomId: "room-1" }));

    authorizeJoinCalls = [];
    authorizePublishCalls = [];
    presenceCalls = [];
    eventCalls = [];
    fanoutCalls = [];

    const authorizeJoin: AuthorizeJoin = async (principal, roomKey) => {
      authorizeJoinCalls.push({ userId: principal.userId, roomKey });
      return principal.userId !== "banned-user";
    };
    const authorizePublish: AuthorizePublish = async (principal, roomKey) => {
      authorizePublishCalls.push({ userId: principal.userId, roomKey });
      return principal.userId !== "banned-user";
    };

    router = new RoomNamespaceRouter({
      store,
      authorizeJoin,
      authorizePublish,
      onPresenceUpdate: (userId, status, roomKey) => {
        presenceCalls.push({ userId, status, roomKey });
      },
      onEventPublish: (roomKey, event) => {
        eventCalls.push({ roomKey, event });
      },
      onFanout: (roomKey, message, includeConnectionIds) => {
        fanoutCalls.push({ roomKey, message, includeConnectionIds });
        return includeConnectionIds?.length ?? 0;
      },
    });
  });

  it("joins a room and invokes authorizeJoin", async () => {
    const result = await router.joinRoom(
      makePrincipal("alice"),
      { id: "conn-1" } as any,
      "tenant-1",
      "ns-1",
      "room-1",
    );
    expect(result.ok).toBe(true);
    expect(authorizeJoinCalls).toEqual([
      { userId: "alice", roomKey: encodeRoomKey("tenant-1", "ns-1", "room-1") },
    ]);
  });

  it("rejects join when authorizeJoin returns false", async () => {
    const result = await router.joinRoom(
      makePrincipal("banned-user"),
      { id: "conn-1" } as any,
      "tenant-1",
      "ns-1",
      "room-1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNAUTHORIZED_JOIN");
  });

  it("publishes to a room and invokes authorizePublish", async () => {
    // First join
    await router.joinRoom(
      makePrincipal("alice"),
      { id: "conn-1" } as any,
      "tenant-1",
      "ns-1",
      "room-1",
    );

    const result = await router.publishToRoom(
      makePrincipal("alice"),
      encodeRoomKey("tenant-1", "ns-1", "room-1"),
      { text: "hello" },
    );
    expect(result.ok).toBe(true);
    expect(authorizePublishCalls).toEqual([
      { userId: "alice", roomKey: encodeRoomKey("tenant-1", "ns-1", "room-1") },
    ]);
  });

  it("rejects publish when authorizePublish returns false", async () => {
    await router.joinRoom(
      makePrincipal("banned-user"),
      { id: "conn-1" } as any,
      "tenant-1",
      "ns-1",
      "room-1",
    );
    const result = await router.publishToRoom(
      makePrincipal("banned-user"),
      encodeRoomKey("tenant-1", "ns-1", "room-1"),
      { text: "hello" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNAUTHORIZED_PUBLISH");
  });

  it("publishes to non-existent room returns ROOM_NOT_FOUND", async () => {
    const result = await router.publishToRoom(
      makePrincipal("alice"),
      encodeRoomKey("tenant-1", "ns-1", "nonexistent"),
      { text: "hello" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ROOM_NOT_FOUND");
  });

  it("tracks presence and event callbacks on join", async () => {
    await router.joinRoom(
      makePrincipal("alice"),
      { id: "conn-1" } as any,
      "tenant-1",
      "ns-1",
      "room-1",
    );
    expect(presenceCalls.length).toBe(1);
    expect(presenceCalls[0]).toMatchObject({ userId: "alice", status: "online" });
    expect(eventCalls.length).toBe(1);
    expect(eventCalls[0].event.type).toBe("member_joined");
  });

  it("removes all memberships on disconnect", async () => {
    await router.joinRoom(
      makePrincipal("alice"),
      { id: "conn-1" } as any,
      "tenant-1",
      "ns-1",
      "room-1",
    );
    await router.handleDisconnect("conn-1");
    expect(await store.getMemberCount(encodeRoomKey("tenant-1", "ns-1", "room-1"))).toBe(0);
  });
});
