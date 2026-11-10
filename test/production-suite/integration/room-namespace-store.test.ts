/**
 * Room-namespace store adapter integration tests.
 *
 * Exercises an in-memory `RoomNamespaceStore`: namespace/room CRUD, membership
 * add/remove, and `getConnectionsForUser` across disconnects.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type {
  NamespaceRecord,
  RoomRecord,
  RoomNamespaceStore,
  Membership,
} from "../../../src/room-namespace/types.js";
import { encodeRoomKey } from "../../../src/room-namespace/room-key.js";

class InMemoryRoomNamespaceStore implements RoomNamespaceStore {
  private namespaces = new Map<string, NamespaceRecord>();
  private rooms = new Map<string, RoomRecord>();
  private memberships = new Map<string, Map<string, { userId: string; joinedAt: number }>>();

  async getNamespace(tenantId: string, namespaceId: string): Promise<NamespaceRecord | null> {
    return this.namespaces.get(`${tenantId}:${namespaceId}`) ?? null;
  }
  async createNamespace(record: NamespaceRecord): Promise<void> {
    this.namespaces.set(`${record.tenantId}:${record.namespaceId}`, record);
  }
  async deleteNamespace(tenantId: string, namespaceId: string): Promise<void> {
    this.namespaces.delete(`${tenantId}:${namespaceId}`);
  }
  async listNamespaces(tenantId: string): Promise<NamespaceRecord[]> {
    return [...this.namespaces.values()].filter((n) => n.tenantId === tenantId);
  }
  async getRoom(roomKey: string): Promise<RoomRecord | null> {
    return this.rooms.get(roomKey) ?? null;
  }
  async createRoom(record: RoomRecord): Promise<void> {
    this.rooms.set(encodeRoomKey(record.tenantId, record.namespaceId, record.roomId), record);
  }
  async deleteRoom(roomKey: string): Promise<void> {
    this.rooms.delete(roomKey);
  }
  async listRooms(tenantId: string, namespaceId: string): Promise<RoomRecord[]> {
    return [...this.rooms.values()].filter((r) => r.tenantId === tenantId && r.namespaceId === namespaceId);
  }
  async getMembership(roomKey: string, connectionId: string): Promise<Membership | null> {
    const byConn = this.memberships.get(roomKey);
    const entry = byConn?.get(connectionId);
    if (!entry) return null;
    return { roomKey, connectionId, userId: entry.userId, joinedAt: entry.joinedAt };
  }
  async getMembers(roomKey: string): Promise<Membership[]> {
    const byConn = this.memberships.get(roomKey) ?? new Map();
    return [...byConn.entries()].map(([connectionId, m]) => ({ roomKey, connectionId, userId: m.userId, joinedAt: m.joinedAt }));
  }
  async getMemberCount(roomKey: string): Promise<number> {
    return (this.memberships.get(roomKey) ?? new Map()).size;
  }
  // eslint-disable-next-line no-unused-vars
  async getConnectionsForUser(userId: string, _tenantId: string): Promise<string[]> {
    const result: string[] = [];
    for (const byConn of this.memberships.values()) {
      for (const [connectionId, m] of byConn) {
        if (m.userId === userId) result.push(connectionId);
      }
    }
    return result;
  }
  async addMembership(membership: { roomKey: string; connectionId: string; userId: string; joinedAt: number }): Promise<void> {
    let byConn = this.memberships.get(membership.roomKey);
    if (!byConn) {
      byConn = new Map();
      this.memberships.set(membership.roomKey, byConn);
    }
    byConn.set(membership.connectionId, { userId: membership.userId, joinedAt: membership.joinedAt });
  }
  async removeMembership(roomKey: string, connectionId: string): Promise<void> {
    this.memberships.get(roomKey)?.delete(connectionId);
  }
  async removeAllMembershipsForConnection(connectionId: string): Promise<void> {
    for (const byConn of this.memberships.values()) {
      byConn.delete(connectionId);
    }
  }
  async getRoomsForConnection(connectionId: string): Promise<string[]> {
    const result: string[] = [];
    for (const [roomKey, byConn] of this.memberships) {
      if (byConn.has(connectionId)) result.push(roomKey);
    }
    return result;
  }
}

const roomKey = encodeRoomKey("tenant-1", "ns-1", "room-1");

describe("room-namespace store adapter", () => {
  let store: InMemoryRoomNamespaceStore;

  beforeEach(() => {
    store = new InMemoryRoomNamespaceStore();
  });

  it("supports namespace and room CRUD", async () => {
    await store.createNamespace({ tenantId: "tenant-1", namespaceId: "ns-1", policyId: "p" });
    expect((await store.getNamespace("tenant-1", "ns-1"))?.policyId).toBe("p");

    await store.createRoom({ tenantId: "tenant-1", namespaceId: "ns-1", roomId: "room-1", maxMembers: 10, encryptionPolicy: "disabled" });
    expect((await store.getRoom(roomKey))?.maxMembers).toBe(10);

    const rooms = await store.listRooms("tenant-1", "ns-1");
    expect(rooms.length).toBe(1);

    await store.deleteRoom(roomKey);
    expect(await store.getRoom(roomKey)).toBeNull();
  });

  it("tracks membership add/remove and connections for a user", async () => {
    await store.createNamespace({ tenantId: "tenant-1", namespaceId: "ns-1", policyId: "p" });
    await store.createRoom({ tenantId: "tenant-1", namespaceId: "ns-1", roomId: "room-1", maxMembers: 10, encryptionPolicy: "disabled" });

    await store.addMembership({ roomKey, connectionId: "c-alice", userId: "alice", joinedAt: Date.now() });
    await store.addMembership({ roomKey, connectionId: "c-bob", userId: "bob", joinedAt: Date.now() });

    expect((await store.getMemberCount(roomKey))).toBe(2);
    expect((await store.getMembers(roomKey)).map((m) => m.connectionId).sort()).toEqual(["c-alice", "c-bob"]);
    expect((await store.getConnectionsForUser("alice", "tenant-1"))).toContain("c-alice");
    expect((await store.getRoomsForConnection("c-alice"))).toContain(roomKey);

    await store.removeMembership(roomKey, "c-alice");
    expect((await store.getMemberCount(roomKey))).toBe(1);
    expect((await store.getConnectionsForUser("alice", "tenant-1"))).toEqual([]);
  });
});
