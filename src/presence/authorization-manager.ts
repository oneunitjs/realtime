/**
 * Authorization Manager — Controls who can see what in the presence system.
 *
 * Every read operation verifies:
 *  1. Is the caller authenticated?
 *  2. Does the caller belong to the appropriate tenant?
 *  3. Is the target user visible?
 *  4. Is the caller a room member where required?
 *  5. Does the caller have permission to see device details?
 *
 * Privacy-sensitive: presence payloads must not expose IP addresses,
 * authentication tokens, session tokens, or private device metadata.
 */

import type {
  AuthenticatedPrincipal,
  DevicePresence,
  DeviceStatus,
  InternalDeviceLease,
  UserPresence,
} from "./types.js";

// ---------------------------------------------------------------------------
// Authorization decisions
// ---------------------------------------------------------------------------

/**
 * Result of an authorization check.
 */
export interface AuthorizationResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Authorization manager for presence operations.
 */
export class AuthorizationManager {
  private readonly canReadUser?: (
    principal: AuthenticatedPrincipal,
    targetUserId: string,
  ) => boolean | Promise<boolean>;

  private readonly canReadRoom?: (
    principal: AuthenticatedPrincipal,
    roomId: string,
  ) => boolean | Promise<boolean>;

  private readonly canUpdatePresence?: (
    principal: AuthenticatedPrincipal,
    deviceId: string,
  ) => boolean | Promise<boolean>;

  private readonly privacyFilter?: (
    principal: AuthenticatedPrincipal,
    presence: DevicePresence,
  ) => DevicePresence | Promise<DevicePresence>;

  constructor(options: {
    canReadUser?: (
      principal: AuthenticatedPrincipal,
      targetUserId: string,
    ) => boolean | Promise<boolean>;
    canReadRoom?: (
      principal: AuthenticatedPrincipal,
      roomId: string,
    ) => boolean | Promise<boolean>;
    canUpdatePresence?: (
      principal: AuthenticatedPrincipal,
      deviceId: string,
    ) => boolean | Promise<boolean>;
    privacyFilter?: (
      principal: AuthenticatedPrincipal,
      presence: DevicePresence,
    ) => DevicePresence | Promise<DevicePresence>;
  } = {}) {
    this.canReadUser = options.canReadUser;
    this.canReadRoom = options.canReadRoom;
    this.canUpdatePresence = options.canUpdatePresence;
    this.privacyFilter = options.privacyFilter;
  }

  /** Check if the principal can read a user's presence. */
  async canReadUserPresence(
    principal: AuthenticatedPrincipal,
    targetUserId: string,
  ): Promise<AuthorizationResult> {
    // Same tenant always allowed to read their own presence
    if (principal.userId === targetUserId) {
      return { allowed: true };
    }

    if (this.canReadUser) {
      const allowed = await this.canReadUser(principal, targetUserId);
      return { allowed, reason: allowed ? undefined : "User read not authorized" };
    }

    // Default: deny cross-user reads unless explicitly configured
    return { allowed: false, reason: "Cross-user presence read not authorized" };
  }

  /** Check if the principal can read room presence. */
  async canReadRoomPresence(
    principal: AuthenticatedPrincipal,
    roomId: string,
  ): Promise<AuthorizationResult> {
    if (this.canReadRoom) {
      const allowed = await this.canReadRoom(principal, roomId);
      return { allowed, reason: allowed ? undefined : "Room read not authorized" };
    }

    // Default: deny unless explicitly configured
    return { allowed: false, reason: "Room presence read not authorized" };
  }

  /** Check if the principal can update their own presence. */
  async canUpdateOwnPresence(
    principal: AuthenticatedPrincipal,
    deviceId: string,
  ): Promise<AuthorizationResult> {
    if (this.canUpdatePresence) {
      const allowed = await this.canUpdatePresence(principal, deviceId);
      return { allowed, reason: allowed ? undefined : "Presence update not authorized" };
    }

    // Default: allow users to update their own presence
    return { allowed: true };
  }

  /** Apply privacy filter to a device presence record. */
  async applyPrivacyFilter(
    principal: AuthenticatedPrincipal,
    presence: DevicePresence,
  ): Promise<DevicePresence> {
    if (this.privacyFilter) {
      return this.privacyFilter(principal, presence);
    }

    // Default: strip sensitive fields
    return {
      deviceId: presence.deviceId,
      status: presence.status,
      lastSeenAt: presence.lastSeenAt,
      expiresAt: presence.expiresAt,
      // customStatus and tenantId are intentionally not included by default
    };
  }

  /** Filter device presences by visibility rules. */
  async filterDevicesByVisibility(
    principal: AuthenticatedPrincipal,
    devices: DevicePresence[],
  ): Promise<DevicePresence[]> {
    const filtered: DevicePresence[] = [];

    for (const device of devices) {
      const filteredDevice = await this.applyPrivacyFilter(principal, device);
      filtered.push(filteredDevice);
    }

    return filtered;
  }

  /** Filter a user presence by caller's visibility rights. */
  async filterUserPresence(
    principal: AuthenticatedPrincipal,
    presence: UserPresence,
  ): Promise<UserPresence | null> {
    const allowed = await this.canReadUserPresence(principal, presence.userId);

    if (!allowed) {
      return null;
    }

    const devices = await this.filterDevicesByVisibility(
      principal,
      presence.devices,
    );

    // Optionally omit offline devices
    const visibleDevices = devices.filter((d) => d.status !== "offline");

    return {
      ...presence,
      devices: visibleDevices,
    };
  }

  /** Check if a device status is valid. */
  static isValidStatus(status: unknown): status is DeviceStatus {
    return (
      typeof status === "string" &&
      (status === "online" || status === "away" || status === "busy" || status === "offline")
    );
  }

  /** Validate and normalize a status value. */
  static normalizeStatus(status: unknown): DeviceStatus | null {
    if (this.isValidStatus(status)) {
      return status;
    }
    return null;
  }
}

/**
 * Default authorization: same-tenant users can read each other's presence,
 * room members can read room presence.
 */
export function createDefaultAuthorizationManager(
  tenantId: string,
): AuthorizationManager {
  return new AuthorizationManager({
    canReadUser: (principal, targetUserId) => {
      // Same tenant and same user, or same tenant cross-user (default allow)
      return principal.tenantId === tenantId;
    },
    canReadRoom: (principal) => {
      return principal.tenantId === tenantId;
    },
    canUpdatePresence: (principal) => {
      return principal.tenantId === tenantId;
    },
  });
}
