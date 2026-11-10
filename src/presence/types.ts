/**
 * Presence Management System — Data Model Types
 *
 * Authoritative type definitions for the Presence Management subsystem,
 * following the Presence Management Architecture v1.0 specification.
 */

// ---------------------------------------------------------------------------
// Status types
// ---------------------------------------------------------------------------

/**
 * Device-level presence status.
 * A single device (browser tab, mobile app, desktop client) reports one of
 * these statuses.
 */
export type DeviceStatus = "online" | "away" | "busy" | "offline";

/**
 * Deterministic aggregate precedence order.
 *
 * When multiple devices report different statuses, the user's aggregate
 * status is computed as:
 *   1. If any device is online → online
 *   2. Else if any device is busy → busy
 *   3. Else if any device is away → away
 *   4. Else → offline
 *
 * Product teams may choose a different order, but the rule must be
 * documented and stable so all instances and clients agree.
 */
export const AGGREGATE_PRECEDENCE: DeviceStatus[] = [
  "online",
  "busy",
  "away",
  "offline",
] as const;

// ---------------------------------------------------------------------------
// Core data model
// ---------------------------------------------------------------------------

/**
 * Device presence — state of one browser tab / mobile app / desktop client.
 *
 * A device presence entry is a lease: extended by heartbeats and
 * authenticated activity, expires if the client goes silent.
 */
export interface DevicePresence {
  /** Unique device identifier, bound to the authenticated session. */
  deviceId: string;
  /** Live Hub connection ID, if currently connected. */
  connectionId?: string;
  /** Current device-level status. */
  status: DeviceStatus;
  /** Last time the device was observed active (ms epoch). */
  lastSeenAt: number;
  /** Lease expiry time (ms epoch). */
  expiresAt: number;
  /** Optional short custom status text. */
  customStatus?: string;
  /** Tenant ID for multi-tenant isolation. */
  tenantId?: string;
}

/**
 * User presence — aggregate computed from all of a user's devices.
 */
export interface UserPresence {
  userId: string;
  /** Aggregate status computed from device statuses. */
  status: DeviceStatus;
  /** All active device presence records for this user. */
  devices: DevicePresence[];
  /** Last time the aggregate was recalculated (ms epoch). */
  updatedAt: number;
  /** Tenant ID for multi-tenant isolation. */
  tenantId?: string;
}

// ---------------------------------------------------------------------------
// Internal lease entities
// ---------------------------------------------------------------------------

/**
 * Internal device lease stored in the Presence Store.
 *
 * Includes versioning for concurrency control and tenant isolation.
 */
export interface InternalDeviceLease {
  tenantId: string;
  userId: string;
  deviceId: string;
  connectionId: string;
  status: DeviceStatus;
  lastSeenAt: number;
  expiresAt: number;
  version: number;
}

/**
 * Room membership index entry for room-level presence projections.
 */
export interface PresenceRoomMembership {
  roomId: string;
  tenantId: string;
  userId: string;
  joinedAt: number;
}

/**
 * Presence subscription record for organizing event distribution.
 */
export interface PresenceSubscription {
  subscriberId: string;
  roomId?: string;
  tenantId: string;
}

// ---------------------------------------------------------------------------
// Awareness (typing / cursor) types
// ---------------------------------------------------------------------------

/**
 * Typing event payload (client → server).
 */
export interface AwarenessTypingStart {
  type: "awareness.typing.start";
  roomId: string;
}

/**
 * Typing stop event payload (client → server).
 */
export interface AwarenessTypingStop {
  type: "awareness.typing.stop";
  roomId: string;
}

/**
 * Typing update event payload (server → client).
 */
export interface AwarenessTypingUpdated {
  type: "awareness.typing.updated";
  roomId: string;
  userId: string;
  isTyping: boolean;
}

/**
 * Cursor update event payload (client → server).
 */
export interface AwarenessCursorUpdate {
  type: "awareness.cursor.update";
  roomId: string;
  documentId: string;
  cursor: unknown; // Application-specific cursor schema
}

/**
 * Cursor updated event payload (server → client).
 */
export interface AwarenessCursorUpdated {
  type: "awareness.cursor.updated";
  roomId: string;
  documentId: string;
  userId: string;
  cursor: unknown;
}

/**
 * Union of all awareness event payloads.
 */
export type AwarenessEvent =
  | AwarenessTypingStart
  | AwarenessTypingStop
  | AwarenessTypingUpdated
  | AwarenessCursorUpdate
  | AwarenessCursorUpdated;

// ---------------------------------------------------------------------------
// Presence update events
// ---------------------------------------------------------------------------

/**
 * Presence user updated event (published to subscribers).
 */
export interface PresenceUserUpdated {
  type: "presence.user.updated";
  data: {
    userId: string;
    status: DeviceStatus;
    updatedAt: number;
  };
}

/**
 * Presence room updated event (published to subscribers).
 */
export interface PresenceRoomUpdated {
  type: "presence.room.updated";
  data: {
    roomId: string;
    members: Array<{ userId: string; status: DeviceStatus }>;
  };
}

/**
 * Union of presence system events.
 */
export type PresenceSystemEvent =
  | PresenceUserUpdated
  | PresenceRoomUpdated
  | AwarenessEvent;

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export type { AuthenticatedPrincipal } from "../core/connection/connection.types.js";

/**
 * Connection context for a live Hub connection.
 */
export interface ConnectionContext {
  connectionId: string;
  deviceId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Cursor payload for awareness updates (application-specific schema).
 */
export interface CursorPayload {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/**
 * Presence system error codes.
 */
export type PresenceErrorCode =
  | "PRESENCE_UNAUTHORIZED"
  | "PRESENCE_FORBIDDEN"
  | "PRESENCE_NOT_FOUND"
  | "PRESENCE_INVALID_STATUS"
  | "PRESENCE_INVALID_PAYLOAD"
  | "PRESENCE_RATE_LIMITED"
  | "PRESENCE_CONNECTION_REQUIRED"
  | "PRESENCE_SERVICE_UNAVAILABLE"
  | "PRESENCE_CONFLICT";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Presence system configuration defaults.
 */
export interface PresenceConfig {
  /** Heartbeat interval in milliseconds (client-side). */
  heartbeatIntervalMs: number;
  /** Lease TTL in milliseconds. */
  leaseTtlMs: number;
  /** Expiry grace period in milliseconds. */
  expiryGraceMs: number;
  /** Expiry worker interval in milliseconds. */
  expiryWorkerIntervalMs: number;
  /** Maximum custom status length. */
  maxCustomStatusLength: number;
  /** Whether to omit offline users from presence lists. */
  omitOfflineUsers: boolean;
}

/**
 * Default presence configuration.
 */
export const DEFAULT_PRESENCE_CONFIG: PresenceConfig = {
  heartbeatIntervalMs: 25_000,
  leaseTtlMs: 75_000,
  expiryGraceMs: 15_000,
  expiryWorkerIntervalMs: 5_000,
  maxCustomStatusLength: 256,
  omitOfflineUsers: false,
};

// ---------------------------------------------------------------------------
// Storage interface
// ---------------------------------------------------------------------------

/**
 * Presence Store interface.
 *
 * The store holds temporary presence state with TTLs. A Redis-compatible
 * store is the recommended implementation choice because it supports fast
 * access, TTLs, and atomic operations.
 */
export interface PresenceStore {
  /** Create or refresh a device lease. */
  createOrRefreshLease(lease: InternalDeviceLease): Promise<void>;
  /** Get a device lease by ID. */
  getLease(deviceId: string): Promise<InternalDeviceLease | null>;
  /** Get all active leases for a user. */
  getUserLeases(userId: string, tenantId: string): Promise<InternalDeviceLease[]>;
  /** Remove a device lease. */
  removeLease(deviceId: string): Promise<void>;
  /** Find all expired leases (past expiresAt + grace). */
  findExpiredLeases(): Promise<InternalDeviceLease[]>;
  /** Add a user to a room membership index. */
  addRoomMembership(membership: PresenceRoomMembership): Promise<void>;
  /** Remove a user from a room membership index. */
  removeRoomMembership(roomId: string, userId: string, tenantId: string): Promise<void>;
  /** Get all members of a room. */
  getRoomMembers(roomId: string, tenantId: string): Promise<PresenceRoomMembership[]>;
  /** Close the store connection. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Transport adapters
// ---------------------------------------------------------------------------

/**
 * The presence subsystem uses the canonical {@link TransportConnection}
 * from `src/core/connection/connection.types.js` instead of its own
 * socket interface. This keeps a single transport contract across the
 * codebase (docs/architecture-consolidation-uws-plan-v2.md §7 / §10).
 */
