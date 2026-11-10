/**
 * Presence Service — Main business logic layer for presence management.
 *
 * Manages device leases, user aggregates, awareness signals, and event
 * publishing. All public API operations pass through this service.
 *
 * The service is storage-agnostic: it works with any PresenceStore
 * implementation (in-memory for single-instance, Redis for multi-instance).
 */

import type {
  AuthenticatedPrincipal,
  ConnectionContext,
  DevicePresence,
  DeviceStatus,
  InternalDeviceLease,
  PresenceConfig,
  PresenceStore,
  PresenceSystemEvent,
  UserPresence,
} from "./types.js";
import {
  createLease,
  isLeaseExpired,
  leaseToDevicePresence,
  refreshLease,
} from "./lease-manager.js";
import {
  buildUserPresence,
  calculateUserStatus,
  presenceChanged,
} from "./aggregation-manager.js";
import { AuthorizationManager } from "./authorization-manager.js";
import { PresenceEventPublisher } from "./event-publisher.js";
import { AwarenessManager } from "./awareness-manager.js";
import { DEFAULT_PRESENCE_CONFIG } from "./types.js";

// ---------------------------------------------------------------------------
// Presence Service
// ---------------------------------------------------------------------------

export class PresenceService {
  private readonly store: PresenceStore;
  private readonly config: PresenceConfig;
  private readonly authorization: AuthorizationManager;
  private readonly publisher: PresenceEventPublisher;
  private readonly awareness: AwarenessManager;

  // User aggregate cache: userId -> UserPresence
  private readonly userAggregates = new Map<string, UserPresence>();
  // Device lease cache: deviceId -> InternalDeviceLease
  private readonly deviceLeases = new Map<string, InternalDeviceLease>();

  constructor(options: {
    store: PresenceStore;
    config?: Partial<PresenceConfig>;
    authorization?: AuthorizationManager;
    publisher?: PresenceEventPublisher;
    awareness?: AwarenessManager;
  }) {
    this.store = options.store;
    this.config = { ...DEFAULT_PRESENCE_CONFIG, ...options.config };
    this.authorization = options.authorization ?? new AuthorizationManager();
    this.publisher = options.publisher ?? new PresenceEventPublisher(() => {});
    this.awareness = options.awareness ?? new AwarenessManager(this.config, () => {});

    // Wire awareness events to the publisher
    // (The AwarenessManager callback is set after construction)
  }

  // ------------------------------------------------------------------
  // Connection lifecycle
  // ------------------------------------------------------------------

  /**
   * Handle an authenticated connection establishment.
   * Creates or refreshes a device lease and publishes presence if changed.
   */
  async connect(
    principal: AuthenticatedPrincipal,
    connection: ConnectionContext,
  ): Promise<UserPresence> {
    // Check authorization
    const canUpdate = await this.authorization.canUpdateOwnPresence(
      principal,
      connection.deviceId ?? principal.userId,
    );
    if (!canUpdate.allowed) {
      throw new Error(canUpdate.reason ?? "Presence update not authorized");
    }

    // Create or refresh lease
    const existing = this.deviceLeases.get(connection.deviceId ?? principal.userId);
    const now = Date.now();

    let lease: InternalDeviceLease;

    if (existing && !isLeaseExpired(existing, this.config.expiryGraceMs, now)) {
      // Refresh existing lease
      lease = refreshLease(existing, this.config, "online");
    } else {
      // Create new lease
      lease = createLease(principal, connection, this.config);
    }

    // Persist lease
    await this.store.createOrRefreshLease(lease);
    this.deviceLeases.set(lease.deviceId, lease);

    // Calculate user aggregate
    const userLeases = await this.store.getUserLeases(principal.userId, principal.tenantId);
    const allLeases = [...userLeases, lease];
    const aggregate = buildUserPresence(principal.userId, allLeases, {
      omitOfflineUsers: this.config.omitOfflineUsers,
      tenantId: principal.tenantId,
    });

    const previous = this.userAggregates.get(principal.userId);
    this.userAggregates.set(principal.userId, aggregate);

    // Publish if changed
    if (presenceChanged(previous, aggregate)) {
      await this.publisher.publishUserUpdated(
        principal.userId,
        aggregate.status,
        aggregate.updatedAt,
      );
    }

    return aggregate;
  }

  /**
   * Handle a heartbeat from a connected device.
   * Extends the lease TTL without publishing events unless status changed.
   */
  async heartbeat(connectionId: string): Promise<void> {
    // Find the lease by connection ID
    let lease: InternalDeviceLease | undefined;

    for (const [, l] of this.deviceLeases) {
      if (l.connectionId === connectionId) {
        lease = l;
        break;
      }
    }

    if (!lease) {
      // Try to load from storage
      const stored = await this.store.getLease(connectionId);
      if (!stored) {
        return; // Unknown connection, ignore
      }
      lease = stored;
      this.deviceLeases.set(stored.deviceId, stored);
    }

    const now = Date.now();
    if (isLeaseExpired(lease, this.config.expiryGraceMs, now)) {
      return; // Already expired, let expiry worker handle it
    }

    // Refresh lease
    const refreshed = refreshLease(lease, this.config, lease.status);
    await this.store.createOrRefreshLease(refreshed);
    this.deviceLeases.set(refreshed.deviceId, refreshed);
  }

  /**
   * Handle a device disconnection.
   * Removes the device lease and recalculates the user aggregate.
   * Does NOT mark the whole user offline if another device is live.
   */
  async disconnect(connectionId: string): Promise<UserPresence | null> {
    let lease: InternalDeviceLease | undefined;

    for (const [deviceId, l] of this.deviceLeases) {
      if (l.connectionId === connectionId) {
        lease = l;
        this.deviceLeases.delete(deviceId);
        break;
      }
    }

    if (!lease) {
      return null;
    }

    // Remove from storage
    await this.store.removeLease(lease.deviceId);

    // Clear awareness for this user's rooms
    this.awareness.clearUserRoomAwareness(lease.userId, ""); // Clear all rooms

    // Recalculate user aggregate
    const userLeases = await this.store.getUserLeases(lease.userId, lease.tenantId);
    const aggregate = buildUserPresence(lease.userId, userLeases, {
      omitOfflineUsers: this.config.omitOfflineUsers,
      tenantId: lease.tenantId,
    });

    const previous = this.userAggregates.get(lease.userId);
    this.userAggregates.set(lease.userId, aggregate);

    // Publish if changed
    if (presenceChanged(previous, aggregate)) {
      await this.publisher.publishUserUpdated(
        lease.userId,
        aggregate.status,
        aggregate.updatedAt,
      );
    }

    return aggregate;
  }

  // ------------------------------------------------------------------
  // Presence queries
  // ------------------------------------------------------------------

  /**
   * Get a user's presence (aggregate + device list).
   * Caller must be authorized to read the target user's presence.
   */
  async getUser(
    principal: AuthenticatedPrincipal,
    userId: string,
  ): Promise<UserPresence | null> {
    const canRead = await this.authorization.canReadUserPresence(principal, userId);
    if (!canRead.allowed) {
      return null;
    }

    const leases = await this.store.getUserLeases(userId, principal.tenantId);
    const aggregate = buildUserPresence(userId, leases, {
      omitOfflineUsers: this.config.omitOfflineUsers,
      tenantId: principal.tenantId,
    });

    this.userAggregates.set(userId, aggregate);
    return aggregate;
  }

  /**
   * Get a single device's presence.
   */
  async getDevice(
    principal: AuthenticatedPrincipal,
    deviceId: string,
  ): Promise<DevicePresence | null> {
    const lease = await this.store.getLease(deviceId);
    if (!lease) {
      return null;
    }

    // Check authorization: caller must be able to read the device owner's presence
    const canRead = await this.authorization.canReadUserPresence(principal, lease.userId);
    if (!canRead.allowed) {
      return null;
    }

    return leaseToDevicePresence(lease);
  }

  /**
   * Get room presence — authorized projection of members' presence.
   */
  async getRoom(
    principal: AuthenticatedPrincipal,
    roomId: string,
  ): Promise<Array<{ userId: string; status: DeviceStatus }>> {
    const canRead = await this.authorization.canReadRoomPresence(principal, roomId);
    if (!canRead.allowed) {
      return [];
    }

    // Get room memberships, then fetch presence for each member
    // This is a simplified implementation — in production, room memberships
    // would come from the store's room index
    const members: Array<{ userId: string; status: DeviceStatus }> = [];

    // Use cached aggregates as a fallback
    for (const [userId, aggregate] of this.userAggregates) {
      members.push({ userId, status: aggregate.status });
    }

    return members;
  }

  // ------------------------------------------------------------------
  // Status updates
  // ------------------------------------------------------------------

  /**
   * Update the authenticated device's status.
   * Validates status, updates lease, recalculates aggregate, publishes if changed.
   */
  async setStatus(
    principal: AuthenticatedPrincipal,
    deviceId: string,
    status: DeviceStatus,
  ): Promise<UserPresence> {
    // Validate status
    if (!AuthorizationManager.isValidStatus(status)) {
      throw new Error("PRESENCE_INVALID_STATUS");
    }

    // Check authorization
    const canUpdate = await this.authorization.canUpdateOwnPresence(
      principal,
      deviceId,
    );
    if (!canUpdate.allowed) {
      throw new Error(canUpdate.reason ?? "Presence update not authorized");
    }

    // Get existing lease
    const existing = this.deviceLeases.get(deviceId);
    if (!existing) {
      throw new Error("PRESENCE_NOT_FOUND");
    }

    // Verify the device belongs to this user
    if (existing.userId !== principal.userId) {
      throw new Error("PRESENCE_FORBIDDEN");
    }

    // Refresh lease with new status
    const now = Date.now();
    const updated = refreshLease(existing, this.config, status);
    await this.store.createOrRefreshLease(updated);
    this.deviceLeases.set(updated.deviceId, updated);

    // Recalculate user aggregate
    const userLeases = await this.store.getUserLeases(principal.userId, principal.tenantId);
    const aggregate = buildUserPresence(principal.userId, userLeases, {
      omitOfflineUsers: this.config.omitOfflineUsers,
      tenantId: principal.tenantId,
    });

    const previous = this.userAggregates.get(principal.userId);
    this.userAggregates.set(principal.userId, aggregate);

    // Publish if changed
    if (presenceChanged(previous, aggregate)) {
      await this.publisher.publishUserUpdated(
        principal.userId,
        aggregate.status,
        aggregate.updatedAt,
      );
    }

    return aggregate;
  }

  // ------------------------------------------------------------------
  // Awareness delegation
  // ------------------------------------------------------------------

  /**
   * Handle a typing start event.
   */
  typingStart(userId: string, roomId: string): void {
    this.awareness.typingStart(
      { type: "awareness.typing.start", roomId },
      userId,
    );
  }

  /**
   * Handle a typing stop event.
   */
  typingStop(userId: string, roomId: string): void {
    this.awareness.typingStop(
      { type: "awareness.typing.stop", roomId },
      userId,
    );
  }

  /**
   * Handle a cursor update event.
   */
  cursorUpdate(
    userId: string,
    roomId: string,
    documentId: string,
    cursor: unknown,
  ): void {
    this.awareness.cursorUpdate(
      {
        type: "awareness.cursor.update",
        roomId,
        documentId,
        cursor,
      },
      userId,
    );
  }

  // ------------------------------------------------------------------
  // Expiry
  // ------------------------------------------------------------------

  /**
   * Run one expiry sweep (remove expired leases, recalculate aggregates).
   */
  async sweepExpiry(): Promise<void> {
    const expired = await this.store.findExpiredLeases();

    const usersToRecalculate = new Set<string>();

    for (const lease of expired) {
      if (isLeaseExpired(lease, this.config.expiryGraceMs)) {
        await this.store.removeLease(lease.deviceId);
        this.deviceLeases.delete(lease.deviceId);
        usersToRecalculate.add(`${lease.tenantId ?? ""}:${lease.userId}`);
      }
    }

    // Recalculate aggregates for affected users
    for (const key of usersToRecalculate) {
      const [tenantId, userId] = key.split(":");
      const leases = await this.store.getUserLeases(userId, tenantId);
      const aggregate = buildUserPresence(userId, leases, {
        omitOfflineUsers: this.config.omitOfflineUsers,
        tenantId,
      });

      const previous = this.userAggregates.get(userId);
      this.userAggregates.set(userId, aggregate);

      if (presenceChanged(previous, aggregate)) {
        await this.publisher.publishUserUpdated(
          userId,
          aggregate.status,
          aggregate.updatedAt,
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // Accessors
  // ------------------------------------------------------------------

  getConfig(): PresenceConfig {
    return { ...this.config };
  }

  getUserAggregate(userId: string): UserPresence | undefined {
    return this.userAggregates.get(userId);
  }

  getDeviceLease(deviceId: string): InternalDeviceLease | undefined {
    return this.deviceLeases.get(deviceId);
  }
}
