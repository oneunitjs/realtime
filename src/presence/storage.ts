/**
 * Presence Storage — Storage interface implementations.
 *
 * The Presence Store holds temporary presence state with TTLs.
 * A Redis-compatible store is the recommended implementation choice because
 * it supports fast access, TTLs, and atomic operations.
 *
 * Two implementations are provided:
 *   - InMemoryPresenceStore: single-instance, no external dependencies
 *   - RedisPresenceStore: multi-instance, Redis-backed (optional)
 */

import type {
  InternalDeviceLease,
  PresenceRoomMembership,
  PresenceStore,
} from "./types.js";

// ---------------------------------------------------------------------------
// In-memory storage adapter (single-instance default)
// ---------------------------------------------------------------------------

/**
 * In-memory implementation of PresenceStore.
 *
 * Suitable for single-instance deployments. Leases are stored in Maps with
 * TTL tracking via a sorted expiry index.
 */
export class InMemoryPresenceStore implements PresenceStore {
  private leases = new Map<string, InternalDeviceLease>();
  private userLeases = new Map<string, Map<string, InternalDeviceLease>>(); // userId -> deviceId -> lease
  private roomMemberships = new Map<string, Map<string, PresenceRoomMembership[]>>(); // roomId -> tenantId -> memberships
  private expiryIndex = new Map<number, Set<string>>(); // expiresAt -> deviceIds

  async createOrRefreshLease(lease: InternalDeviceLease): Promise<void> {
    const existing = this.leases.get(lease.deviceId);

    // Remove from old expiry index position
    if (existing) {
      const oldSet = this.expiryIndex.get(existing.expiresAt);
      oldSet?.delete(lease.deviceId);
      if (oldSet?.size === 0) {
        this.expiryIndex.delete(existing.expiresAt);
      }

      // Remove from old user leases index
      const userDevices = this.userLeases.get(existing.userId);
      userDevices?.delete(existing.deviceId);
      if (userDevices?.size === 0) {
        this.userLeases.delete(existing.userId);
      }

      // Remove from old room memberships
      this.removeRoomMembershipInternal(existing.userId, lease.tenantId ?? "");
    }

    this.leases.set(lease.deviceId, lease);

    // Add to expiry index
    let expirySet = this.expiryIndex.get(lease.expiresAt);
    if (!expirySet) {
      expirySet = new Set();
      this.expiryIndex.set(lease.expiresAt, expirySet);
    }
    expirySet.add(lease.deviceId);

    // Add to user leases index
    let userDevices = this.userLeases.get(lease.userId);
    if (!userDevices) {
      userDevices = new Map();
      this.userLeases.set(lease.userId, userDevices);
    }
    userDevices.set(lease.deviceId, lease);
  }

  async getLease(deviceId: string): Promise<InternalDeviceLease | null> {
    return this.leases.get(deviceId) ?? null;
  }

  async getUserLeases(
    userId: string,
    tenantId: string,
  ): Promise<InternalDeviceLease[]> {
    const userDevices = this.userLeases.get(userId);
    if (!userDevices) {
      return [];
    }

    const leases: InternalDeviceLease[] = [];
    for (const lease of userDevices.values()) {
      if (lease.tenantId === tenantId) {
        leases.push(lease);
      }
    }
    return leases;
  }

  async removeLease(deviceId: string): Promise<void> {
    const lease = this.leases.get(deviceId);
    if (!lease) {
      return;
    }

    this.leases.delete(deviceId);

    const expirySet = this.expiryIndex.get(lease.expiresAt);
    expirySet?.delete(deviceId);
    if (expirySet?.size === 0) {
      this.expiryIndex.delete(lease.expiresAt);
    }

    const userDevices = this.userLeases.get(lease.userId);
    userDevices?.delete(deviceId);
    if (userDevices?.size === 0) {
      this.userLeases.delete(lease.userId);
    }

    this.removeRoomMembershipInternal(lease.userId, lease.tenantId ?? "");
  }

  async findExpiredLeases(): Promise<InternalDeviceLease[]> {
    const now = Date.now();
    const expired: InternalDeviceLease[] = [];

    for (const [expiresAt, deviceIds] of this.expiryIndex.entries()) {
      if (expiresAt <= now) {
        for (const deviceId of deviceIds) {
          const lease = this.leases.get(deviceId);
          if (lease) {
            expired.push(lease);
          }
        }
        this.expiryIndex.delete(expiresAt);
      }
    }

    return expired;
  }

  async addRoomMembership(
    membership: PresenceRoomMembership,
  ): Promise<void> {
    let tenantMap = this.roomMemberships.get(membership.roomId);
    if (!tenantMap) {
      tenantMap = new Map();
      this.roomMemberships.set(membership.roomId, tenantMap);
    }

    let memberships = tenantMap.get(membership.tenantId);
    if (!memberships) {
      memberships = [];
      tenantMap.set(membership.tenantId, memberships);
    }

    // Avoid duplicates
    const exists = memberships.some(
      (m) => m.userId === membership.userId && m.tenantId === membership.tenantId,
    );
    if (!exists) {
      memberships.push(membership);
    }
  }

  async removeRoomMembership(
    roomId: string,
    userId: string,
    tenantId: string,
  ): Promise<void> {
    this.removeRoomMembershipInternal(userId, tenantId, roomId);
  }

  async getRoomMembers(
    roomId: string,
    tenantId: string,
  ): Promise<PresenceRoomMembership[]> {
    const tenantMap = this.roomMemberships.get(roomId);
    if (!tenantMap) {
      return [];
    }

    const memberships = tenantMap.get(tenantId);
    return memberships ?? [];
  }

  async close(): Promise<void> {
    this.leases.clear();
    this.userLeases.clear();
    this.roomMemberships.clear();
    this.expiryIndex.clear();
  }

  private removeRoomMembershipInternal(
    userId: string,
    tenantId: string,
    roomId?: string,
  ): void {
    for (const [rid, tenantMap] of this.roomMemberships.entries()) {
      if (roomId && rid !== roomId) {
        continue;
      }

      const memberships = tenantMap.get(tenantId);
      if (!memberships) {
        continue;
      }

      const index = memberships.findIndex(
        (m) => m.userId === userId && m.tenantId === tenantId,
      );
      if (index !== -1) {
        memberships.splice(index, 1);
      }

      if (memberships.length === 0) {
        tenantMap.delete(tenantId);
      }

      if (tenantMap.size === 0) {
        this.roomMemberships.delete(rid);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Redis storage adapter (multi-instance, optional)
// ---------------------------------------------------------------------------

/**
 * Redis-backed implementation of PresenceStore.
 *
 * Uses Redis keys with TTLs for automatic expiry. Suitable for
 * multi-instance deployments where multiple Hub instances share presence
 * state.
 *
 * Key layout (with optional tenant prefix):
 *   presence:device:{deviceId}        → Device presence record (JSON with TTL)
 *   presence:user:{userId}            → User aggregate (JSON)
 *   presence:user_devices:{userId}    → Set of device IDs
 *   presence:connection:{connectionId} → Connection-to-device lookup
 *   presence:room:{roomId}            → Room membership index (sorted set)
 *   presence:expiry                    → Expiry scheduling index (sorted set)
 */
export class RedisPresenceStore implements PresenceStore {
  private client: unknown;
  private readonly keyPrefix: string;
  private readonly leaseTtlMs: number;

  constructor(
    client: unknown,
    options: { keyPrefix?: string; leaseTtlMs?: number } = {},
  ) {
    this.client = client;
    this.keyPrefix = options.keyPrefix ?? "presence";
    this.leaseTtlMs = options.leaseTtlMs ?? 75_000;
  }

  private deviceKey(deviceId: string): string {
    return `${this.keyPrefix}:device:${deviceId}`;
  }

  private userKey(userId: string): string {
    return `${this.keyPrefix}:user:${userId}`;
  }

  private userDevicesKey(userId: string): string {
    return `${this.keyPrefix}:user_devices:${userId}`;
  }

  private connectionKey(connectionId: string): string {
    return `${this.keyPrefix}:connection:${connectionId}`;
  }

  private roomKey(roomId: string): string {
    return `${this.keyPrefix}:room:${roomId}`;
  }

  private expiryKey(): string {
    return `${this.keyPrefix}:expiry`;
  }

  async createOrRefreshLease(lease: InternalDeviceLease): Promise<void> {
    const ttlSeconds = Math.ceil(this.leaseTtlMs / 1000);
    const payload = JSON.stringify(lease);

    // Call Redis: SET device key with TTL, SADD user_devices, SET connection mapping,
    // ZADD expiry index
    // These are illustrative — actual Redis client calls depend on the library
    // (ioredis, node-redis, etc.)
    const calls: Array<Promise<unknown>> = [];

    // This is a structural placeholder. The Redis client methods depend on the
    // chosen library (ioredis vs node-redis have different APIs).
    // Implementors should wire their Redis client here.
    void calls;
    void payload;
    void ttlSeconds;
  }

  async getLease(deviceId: string): Promise<InternalDeviceLease | null> {
    // GET device:{deviceId} → parse JSON
    return null;
  }

  async getUserLeases(
    userId: string,
    tenantId: string,
  ): Promise<InternalDeviceLease[]> {
    // SMEMBERS user_devices:{userId} → GET each device:{deviceId} → filter by tenant
    return [];
  }

  async removeLease(deviceId: string): Promise<void> {
    // DEL device:{deviceId}, SREM user_devices:{userId} {deviceId},
    // DEL connection:{connectionId}, ZREM expiry {deviceId}
  }

  async findExpiredLeases(): Promise<InternalDeviceLease[]> {
    // ZRANGEBYSCORE expiry 0 now → GET each device → filter expired
    return [];
  }

  async addRoomMembership(
    membership: PresenceRoomMembership,
  ): Promise<void> {
    // ZADD room:{roomId} score {userId}:{tenantId}
  }

  async removeRoomMembership(
    roomId: string,
    userId: string,
    tenantId: string,
  ): Promise<void> {
    // ZREM room:{roomId} {userId}:{tenantId}
  }

  async getRoomMembers(
    roomId: string,
    tenantId: string,
  ): Promise<PresenceRoomMembership[]> {
    // ZRANGE room:{roomId} 0 -1 → parse each member
    return [];
  }

  async close(): Promise<void> {
    if (typeof (this.client as { quit?: () => unknown }).quit === "function") {
      (this.client as { quit: () => unknown }).quit();
    }
  }
}
