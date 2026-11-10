/**
 * Aggregation Manager — User presence aggregate calculation.
 *
 * Computes deterministic UserPresence aggregates from device leases.
 * The aggregation rule must be stable across all instances so clients
 * always agree on a user's status.
 */

import { AGGREGATE_PRECEDENCE } from "./types.js";
import type { DevicePresence, DeviceStatus, UserPresence } from "./types.js";

/**
 * Calculate the aggregate user status from a list of device statuses.
 *
 * Precedence: online → busy → away → offline
 *
 * If any device is online, the aggregate is online.
 * Otherwise if any device is busy, the aggregate is busy.
 * Otherwise if any device is away, the aggregate is away.
 * Otherwise the aggregate is offline.
 */
export function calculateUserStatus(
  devices: DeviceStatus[],
  precedence: DeviceStatus[] = AGGREGATE_PRECEDENCE,
): DeviceStatus {
  for (const status of precedence) {
    if (devices.includes(status)) {
      return status;
    }
  }

  return "offline";
}

/**
 * Build a UserPresence aggregate from device leases.
 *
 * Filters out offline devices if omitOfflineUsers is true.
 * Sorts devices by lastSeenAt descending.
 */
export function buildUserPresence(
  userId: string,
  devices: DevicePresence[],
  options: {
    omitOfflineUsers?: boolean;
    tenantId?: string;
    precedence?: DeviceStatus[];
  } = {},
): UserPresence {
  const { omitOfflineUsers = false, tenantId, precedence = AGGREGATE_PRECEDENCE } = options;

  const activeDevices = omitOfflineUsers
    ? devices.filter((d) => d.status !== "offline")
    : devices;

  // Sort by lastSeenAt descending (most recent first)
  const sortedDevices = [...activeDevices].sort(
    (a, b) => b.lastSeenAt - a.lastSeenAt,
  );

  const deviceStatuses = sortedDevices.map((d) => d.status);
  const status = calculateUserStatus(deviceStatuses, precedence);

  const now = Date.now();

  return {
    userId,
    status,
    devices: sortedDevices,
    updatedAt: now,
    tenantId,
  };
}

/**
 * Compare two UserPresence objects to determine if a meaningful change
 * occurred that warrants publishing an event.
 *
 * Returns true if status or device list changed meaningfully.
 */
export function presenceChanged(
  previous: UserPresence | null | undefined,
  current: UserPresence,
): boolean {
  if (!previous) {
    return true;
  }

  if (previous.status !== current.status) {
    return true;
  }

  if (previous.devices.length !== current.devices.length) {
    return true;
  }

  for (let i = 0; i < previous.devices.length; i++) {
    const prev = previous.devices[i];
    const curr = current.devices[i];

    if (prev.deviceId !== curr.deviceId) {
      return true;
    }
    if (prev.status !== curr.status) {
      return true;
    }
    if (prev.lastSeenAt !== curr.lastSeenAt) {
      return true;
    }
    if (prev.customStatus !== curr.customStatus) {
      return true;
    }
  }

  return false;
}
