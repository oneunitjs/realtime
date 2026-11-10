/**
 * Lease Manager — Device lease lifecycle management.
 *
 * Creates, refreshes, and removes device leases. A device lease is a
 * temporary record representing a device's active presence. It is extended
 * by authenticated heartbeats and expires if the client goes silent.
 */

import type {
  AuthenticatedPrincipal,
  ConnectionContext,
  DevicePresence,
  DeviceStatus,
  InternalDeviceLease,
  PresenceConfig,
  PresenceStore,
} from "./types.js";
import { calculateUserStatus, buildUserPresence, presenceChanged } from "./aggregation-manager.js";

// ---------------------------------------------------------------------------
// Lease creation
// ---------------------------------------------------------------------------

/**
 * Create a new internal device lease from an authenticated connection.
 *
 * The lease TTL is derived from the presence config. The connection must
 * be authenticated before a lease is created — the userId comes from the
 * authenticated principal, never from client-supplied data.
 */
export function createLease(
  principal: AuthenticatedPrincipal,
  connection: ConnectionContext,
  config: PresenceConfig,
): InternalDeviceLease {
  const now = Date.now();

  return {
    tenantId: principal.tenantId,
    userId: principal.userId,
    deviceId: connection.deviceId ?? principal.userId,
    connectionId: connection.connectionId,
    status: "online",
    lastSeenAt: now,
    expiresAt: now + config.leaseTtlMs,
    version: 1,
  };
}

/**
 * Refresh an existing lease with a new heartbeat timestamp.
 *
 * Extends the lease TTL and updates lastSeenAt. Does not publish a
 * presence event unless the visible status changes.
 */
export function refreshLease(
  existing: InternalDeviceLease,
  config: PresenceConfig,
  status?: DeviceStatus,
): InternalDeviceLease {
  const now = Date.now();

  return {
    ...existing,
    status: status ?? existing.status,
    lastSeenAt: now,
    expiresAt: now + config.leaseTtlMs,
    version: existing.version + 1,
  };
}

// ---------------------------------------------------------------------------
// Lease validation
// ---------------------------------------------------------------------------

/**
 * Check whether a lease has expired (past expiresAt + expiry grace).
 */
export function isLeaseExpired(
  lease: InternalDeviceLease,
  expiryGraceMs: number,
  now: number = Date.now(),
): boolean {
  return now > lease.expiresAt + expiryGraceMs;
}

/**
 * Check whether a lease is still valid.
 */
export function isLeaseValid(
  lease: InternalDeviceLease,
  expiryGraceMs: number,
  now: number = Date.now(),
): boolean {
  return !isLeaseExpired(lease, expiryGraceMs, now);
}

// ---------------------------------------------------------------------------
// Device presence conversion
// ---------------------------------------------------------------------------

/**
 * Convert an internal lease to a public DevicePresence record.
 */
export function leaseToDevicePresence(
  lease: InternalDeviceLease,
): DevicePresence {
  return {
    deviceId: lease.deviceId,
    connectionId: lease.connectionId,
    status: lease.status,
    lastSeenAt: lease.lastSeenAt,
    expiresAt: lease.expiresAt,
    tenantId: lease.tenantId,
  };
}

// ---------------------------------------------------------------------------
// Aggregate calculation
// ---------------------------------------------------------------------------

/**
 * Calculate the user aggregate from device leases.
 */
export function calculateAggregate(
  userId: string,
  leases: InternalDeviceLease[],
  config: PresenceConfig,
): { status: DeviceStatus; devices: DevicePresence[]; updatedAt: number } {
  const devicePresences = leases.map(leaseToDevicePresence);
  const statuses = devicePresences.map((d) => d.status);
  const status = calculateUserStatus(statuses);

  return {
    status,
    devices: devicePresences,
    updatedAt: Date.now(),
  };
}
