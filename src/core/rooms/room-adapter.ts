/**
 * Room Membership Adapter.
 *
 * Bridges the Core Hub's synchronous room membership interface to the
 * consolidated Room/Namespace subsystem (`src/room-namespace/`). The Core Hub
 * expects simple roomId-scoped membership (join/leave/members/rooms), while
 * the consolidated subsystem uses namespace-scoped room keys with full CRUD.
 *
 * Local Maps track per-connection room membership for fast sync access by the
 * Hub; the consolidated service owns the durable store.
 *
 * All room indexes are keyed by tenant-qualified room keys
 * (`encodeRoomKey(tenantId, namespaceId, roomId)`) so that two tenants can
 * independently use the same room name without collision.
 */
import { MembershipManager } from "../../room-namespace/membership-manager.js";
import { encodeRoomKey, decodeRoomKey } from "../../room-namespace/room-key.js";
import type { RoomNamespaceStore, Membership, RoomRecord, NamespaceRecord } from "../../room-namespace/types.js";
import type { Principal } from "../connection/connection.types.js";
import { TenantIsolationError, RoomCapacityError } from "../../error/index.js";

const DEFAULT_NAMESPACE = "default";

// ---------------------------------------------------------------------------
// In-memory RoomNamespaceStore implementation
// ---------------------------------------------------------------------------

class InMemoryRoomNamespaceStore {
  private namespaces = new Map<string, NamespaceRecord>();
  private rooms = new Map<string, RoomRecord>();
  private memberships = new Map<string, Map<string, Membership>>();
  private connectionRooms = new Map<string, Set<string>>();

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
    const result: NamespaceRecord[] = [];
    for (const record of this.namespaces.values()) {
      if (record.tenantId === tenantId) {
        result.push(record);
      }
    }
    return result;
  }

  async getRoom(roomKey: string): Promise<RoomRecord | null> {
    return this.rooms.get(roomKey) ?? null;
  }

  async createRoom(record: RoomRecord): Promise<void> {
    const roomKey = encodeRoomKey(record.tenantId, record.namespaceId, record.roomId);
    this.rooms.set(roomKey, record);
    if (!this.memberships.has(roomKey)) {
      this.memberships.set(roomKey, new Map());
    }
  }

  async deleteRoom(roomKey: string): Promise<void> {
    this.rooms.delete(roomKey);
    this.memberships.delete(roomKey);
  }

  async listRooms(tenantId: string, namespaceId: string): Promise<RoomRecord[]> {
    const result: RoomRecord[] = [];
    for (const record of this.rooms.values()) {
      if (record.tenantId === tenantId && record.namespaceId === namespaceId) {
        result.push(record);
      }
    }
    return result;
  }

  roomCount(): number {
    return this.rooms.size;
  }

  async getMembership(roomKey: string, connectionId: string): Promise<Membership | null> {
    const connMap = this.memberships.get(roomKey);
    return connMap?.get(connectionId) ?? null;
  }

  async getMembers(roomKey: string): Promise<Membership[]> {
    const connMap = this.memberships.get(roomKey);
    return connMap ? [...connMap.values()] : [];
  }

  async getMemberCount(roomKey: string): Promise<number> {
    const connMap = this.memberships.get(roomKey);
    return connMap?.size ?? 0;
  }

  async getConnectionsForUser(userId: string, tenantId: string): Promise<string[]> {
    const result: string[] = [];
    for (const [roomKey, connMap] of this.memberships) {
      const decoded = decodeRoomKey(roomKey);
      if (!decoded || decoded.tenantId !== tenantId) {
        continue;
      }
      for (const membership of connMap.values()) {
        if (membership.userId === userId) {
          result.push(membership.connectionId);
        }
      }
    }
    return result;
  }

  async addMembership(membership: Membership): Promise<void> {
    let connMap = this.memberships.get(membership.roomKey);
    if (!connMap) {
      connMap = new Map();
      this.memberships.set(membership.roomKey, connMap);
    }
    connMap.set(membership.connectionId, membership);

    let rooms = this.connectionRooms.get(membership.connectionId);
    if (!rooms) {
      rooms = new Set();
      this.connectionRooms.set(membership.connectionId, rooms);
    }
    rooms.add(membership.roomKey);
  }

  async removeMembership(roomKey: string, connectionId: string): Promise<void> {
    const connMap = this.memberships.get(roomKey);
    if (connMap) {
      connMap.delete(connectionId);
      if (connMap.size === 0) {
        this.memberships.delete(roomKey);
      }
    }
    const rooms = this.connectionRooms.get(connectionId);
    if (rooms) {
      rooms.delete(roomKey);
      if (rooms.size === 0) {
        this.connectionRooms.delete(connectionId);
      }
    }
  }

  async removeAllMembershipsForConnection(connectionId: string): Promise<void> {
    const rooms = this.connectionRooms.get(connectionId);
    if (rooms) {
      for (const roomKey of rooms) {
        const connMap = this.memberships.get(roomKey);
        if (connMap) {
          connMap.delete(connectionId);
          if (connMap.size === 0) {
            this.memberships.delete(roomKey);
          }
        }
      }
      this.connectionRooms.delete(connectionId);
    }
  }

  async getRoomsForConnection(connectionId: string): Promise<string[]> {
    const rooms = this.connectionRooms.get(connectionId);
    return rooms ? [...rooms] : [];
  }

  // --- Public helpers for the adapter ---

  getAllMemberships(): Map<string, Map<string, Membership>> {
    return this.memberships;
  }

  getConnectionRooms(connectionId: string): Set<string> | undefined {
    return this.connectionRooms.get(connectionId);
  }
}

// ---------------------------------------------------------------------------
// Room Membership Adapter
// ---------------------------------------------------------------------------

export interface RoomMembership {
  connectionId: string;
  roomId: string;
  tenantId: string;
  joinedAt: number;
}

export class RoomAdapter {
  private readonly store: InMemoryRoomNamespaceStore;
  private readonly manager: MembershipManager;
  private readonly roomCapacities: Map<string, number>;
  // Local sync index: roomKey -> Set<connectionId> for fast member lookup.
  // Keyed by tenant-qualified room key to prevent cross-tenant collision.
  private readonly roomMembers = new Map<string, Set<string>>();

  constructor(roomCapacities: Record<string, number> = {}) {
    this.store = new InMemoryRoomNamespaceStore();
    this.manager = new MembershipManager(this.store);
    this.roomCapacities = new Map(Object.entries(roomCapacities));
  }

  /** Build the tenant-qualified room key for the default namespace. */
  private roomKey(tenantId: string, roomId: string): string {
    return encodeRoomKey(tenantId, DEFAULT_NAMESPACE, roomId);
  }

  /** Ensure the default namespace and room exist in the store. */
  private async ensureRoom(tenantId: string, roomId: string): Promise<void> {
    const namespaceId = DEFAULT_NAMESPACE;
    const roomKey = this.roomKey(tenantId, roomId);

    let ns = await this.store.getNamespace(tenantId, namespaceId);
    if (!ns) {
      await this.store.createNamespace({ tenantId, namespaceId, policyId: "default" });
    }

    let room = await this.store.getRoom(roomKey);
    if (!room) {
      await this.store.createRoom({
        tenantId,
        namespaceId,
        roomId,
        maxMembers: this.roomCapacities.get(roomId) ?? 1000,
        encryptionPolicy: "disabled",
      });
    }
  }

  /** Join a connection to a room. Returns { added, membership }. */
  async join(
    connectionId: string,
    principal: Principal,
    tenantId: string,
    roomId: string,
  ): Promise<{ added: boolean; membership: RoomMembership }> {
    const roomKey = this.roomKey(tenantId, roomId);

    // Idempotent: already a member in this room (tenant-qualified)
    const existingConnSet = this.roomMembers.get(roomKey);
    if (existingConnSet?.has(connectionId)) {
      return {
        added: false,
        membership: {
          connectionId,
          roomId,
          tenantId,
          joinedAt: Date.now(),
        },
      };
    }

    // Tenant isolation: if any tenant already has members in a room with
    // the same bare roomId, a different tenant cannot join.
    for (const [existingRoomKey, existingConnSet] of this.roomMembers) {
      if (existingConnSet.size === 0) {
        continue;
      }
      const decoded = decodeRoomKey(existingRoomKey);
      if (!decoded) {
        continue;
      }
      if (decoded.roomId === roomId && decoded.tenantId !== tenantId) {
        throw new TenantIsolationError(
          `Room ${roomId} is isolated to tenant ${decoded.tenantId}`,
        );
      }
    }

    // Tenant isolation: check the store too (for members added before this adapter's local index)
    const allMemberships = this.store.getAllMemberships();
    for (const [storeRoomKey, connMap] of allMemberships) {
      if (connMap.size === 0) {
        continue;
      }
      const decoded = decodeRoomKey(storeRoomKey);
      if (!decoded) {
        continue;
      }
      if (decoded.roomId === roomId && decoded.tenantId !== tenantId) {
        throw new TenantIsolationError(
          `Room ${roomId} is isolated to tenant ${decoded.tenantId}`,
        );
      }
    }

    await this.ensureRoom(tenantId, roomId);

    const result = await this.manager.join(
      { userId: principal.userId, tenantId: principal.tenantId },
      connectionId,
      tenantId,
      DEFAULT_NAMESPACE,
      roomId,
      {
        authorizeJoin: () => true, // Core Hub already authorized via middleware
      },
    );

    if (!result.ok) {
      const errorCode = result.error.code;
      if (errorCode === "ROOM_FULL") {
        const limit = this.roomCapacities.get(roomId) ?? 1000;
        throw new RoomCapacityError(
          `Room ${roomId} is at capacity`,
          limit,
          roomId,
        );
      }
      // Already a member — treat as idempotent no-op
      const existing = await this.store.getMembership(roomKey, connectionId);
      if (existing) {
        return {
          added: false,
          membership: {
            connectionId: existing.connectionId,
            roomId,
            tenantId: decodeRoomKey(existing.roomKey)?.tenantId ?? tenantId,
            joinedAt: existing.joinedAt,
          },
        };
      }
      throw new Error(result.error.message);
    }

    // Track in local sync index using tenant-qualified room key
    let roomConnSet = this.roomMembers.get(roomKey);
    if (!roomConnSet) {
      roomConnSet = new Set();
      this.roomMembers.set(roomKey, roomConnSet);
    }
    roomConnSet.add(connectionId);

    return {
      added: true,
      membership: {
        connectionId,
        roomId,
        tenantId,
        joinedAt: Date.now(),
      },
    };
  }

  /** Leave a room. Returns true if the connection was a member. */
  async leave(connectionId: string, roomId: string): Promise<boolean> {
    const tenantId = this.getConnectionTenantByRoomId(connectionId, roomId);
    if (!tenantId) {
      return false;
    }
    const roomKey = this.roomKey(tenantId, roomId);

    const existing = await this.store.getMembership(roomKey, connectionId);
    if (!existing) {
      return false;
    }

    await this.manager.leave(connectionId, roomKey, {
      onMemberLeft: () => {},
      clearEphemeralState: () => {},
    });

    // Update local sync index
    const connSet = this.roomMembers.get(roomKey);
    if (connSet) {
      connSet.delete(connectionId);
      if (connSet.size === 0) {
        this.roomMembers.delete(roomKey);
      }
    }

    return true;
  }

  /** Get all connection IDs in a room by bare roomId (derives tenant from store). */
  members(roomId: string): string[] {
    const tenantId = this.getAnyTenantForRoomId(roomId);
    if (!tenantId) {
      return [];
    }
    return this.membersByRoomKey(this.roomKey(tenantId, roomId));
  }

  /** Get all connection IDs in a tenant-qualified room (roomKey). */
  membersByRoomKey(roomKey: string): string[] {
    const connSet = this.roomMembers.get(roomKey);
    return connSet ? [...connSet] : [];
  }

  /** Get all room IDs for a connection. */
  rooms(connectionId: string): string[] {
    const roomKeys = this.store.getConnectionRooms(connectionId);
    if (!roomKeys) {
      return [];
    }
    const result: string[] = [];
    for (const roomKey of roomKeys) {
      const decoded = decodeRoomKey(roomKey);
      if (decoded) {
        result.push(decoded.roomId);
      }
    }
    return result;
  }

  /** Remove all memberships for a connection. Returns room IDs. */
  async removeAllForConnection(connectionId: string): Promise<string[]> {
    const rooms = this.rooms(connectionId);
    await this.store.removeAllMembershipsForConnection(connectionId);
    // Clear local sync index
    for (const roomId of rooms) {
      const tenantId = this.getConnectionTenantByRoomId(connectionId, roomId);
      if (tenantId) {
        const roomKey = this.roomKey(tenantId, roomId);
        const connSet = this.roomMembers.get(roomKey);
        if (connSet) {
          connSet.delete(connectionId);
          if (connSet.size === 0) {
            this.roomMembers.delete(roomKey);
          }
        }
      }
    }
    return rooms;
  }

  /** Total number of memberships across all rooms. */
  total(): number {
    let count = 0;
    for (const connMap of this.store.getAllMemberships().values()) {
      count += connMap.size;
    }
    return count;
  }

  /** Total number of rooms across all tenants. */
  roomCount(): number {
    return this.store.roomCount();
  }

  /** Count members in a room by bare roomId (derives tenant from store). */
  count(roomId: string): number {
    const tenantId = this.getAnyTenantForRoomId(roomId);
    if (!tenantId) {
      return 0;
    }
    return this.countByRoomKey(this.roomKey(tenantId, roomId));
  }

  /** Count members in a tenant-qualified room (roomKey). */
  countByRoomKey(roomKey: string): number {
    const connSet = this.roomMembers.get(roomKey);
    return connSet?.size ?? 0;
  }

  /** Get the tenant for a connection in a specific room (by bare roomId). */
  private getConnectionTenantByRoomId(connectionId: string, roomId: string): string | undefined {
    for (const [roomKey, connMap] of this.store.getAllMemberships()) {
      const decoded = decodeRoomKey(roomKey);
      if (decoded && decoded.roomId === roomId) {
        const membership = connMap.get(connectionId);
        if (membership) {
          return decoded.tenantId;
        }
      }
    }
    return undefined;
  }

  /** Get any tenant that has a room with the given bare roomId. */
  private getAnyTenantForRoomId(roomId: string): string | undefined {
    for (const [roomKey] of this.store.getAllMemberships()) {
      const decoded = decodeRoomKey(roomKey);
      if (decoded && decoded.roomId === roomId) {
        return decoded.tenantId;
      }
    }
    return undefined;
  }

  /** Get the tenant for a connection in a specific room key. */
  private getConnectionTenant(connectionId: string, roomKey: string): string | undefined {
    const connMap = this.store.getAllMemberships().get(roomKey);
    if (!connMap) {
      return undefined;
    }
    const membership = connMap.get(connectionId);
    if (!membership) {
      return undefined;
    }
    const decoded = decodeRoomKey(roomKey);
    return decoded?.tenantId;
  }
}
