/**
 * Rooms and Namespaces — Data Model Types
 *
 * Authoritative type definitions following the Rooms and Namespaces
 * Architecture v1.0 specification.
 */

import type { TransportConnection } from "../core/connection/connection.types.js";

// ---------------------------------------------------------------------------
// Core data model
// ---------------------------------------------------------------------------

/**
 * Namespace record — isolation and policy boundary for a logical
 * application area or tenant feature (e.g. `chat`, `docs`, `support`).
 */
export interface NamespaceRecord {
  tenantId: string;
  namespaceId: string;
  policyId: string; // points at rate limits, encryption defaults, etc.
}

/**
 * Room record — named group of authorized connections within a namespace,
 * used for fan-out and shared presence.
 */
export interface RoomRecord {
  tenantId: string;
  namespaceId: string;
  roomId: string;
  maxMembers: number;
  encryptionPolicy: EncryptionPolicy;
}

/**
 * Membership — a connection joined to a room, keyed by canonical roomKey.
 */
export interface Membership {
  roomKey: string;
  connectionId: string;
  userId: string;
  joinedAt: number;
}

/**
 * Encryption policy for a room.
 */
export type EncryptionPolicy = "disabled" | "optional" | "required";

// ---------------------------------------------------------------------------
// Join / publish / leave results
// ---------------------------------------------------------------------------

/**
 * Result of a join operation.
 */
export interface JoinResult {
  ok: boolean;
  roomKey: string;
  connectionId: string;
  memberCount: number;
  error?: RoomError;
}

/**
 * Result of a publish operation.
 */
export interface PublishResult {
  ok: boolean;
  roomKey: string;
  delivered: number;
  error?: RoomError;
}

/**
 * Result of a leave operation.
 */
export interface LeaveResult {
  ok: boolean;
  roomKey: string;
  connectionId: string;
  memberCount: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Room error codes per the Error Handling Architecture registry.
 */
export type RoomErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "NAMESPACE_NOT_FOUND"
  | "UNAUTHORIZED_JOIN"
  | "UNAUTHORIZED_PUBLISH"
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "ENCRYPTION_REQUIRED"
  | "STALE_KEY_EPOCH"
  | "CONNECTION_NOT_AUTHENTICATED"
  | "DISCONNECT_DURING_JOIN";

export interface RoomError {
  code: RoomErrorCode;
  message: string;
  roomKey?: string;
}

// ---------------------------------------------------------------------------
// Connection & principal
// ---------------------------------------------------------------------------

export type { AuthenticatedPrincipal } from "../core/connection/connection.types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Room and namespace limits.
 */
export interface RoomNamespaceLimits {
  maxRoomsPerConnection: number;
  maxMembersPerRoom: number;
  maxNamespacesPerTenant: number;
  maxRoomMetadataSizeBytes: number;
  maxJoinAttemptsPerMinute: number;
  maxFanoutConcurrency: number;
}

/**
 * Default limits — tune per product.
 */
export const DEFAULT_ROOM_NAMESPACE_LIMITS: RoomNamespaceLimits = {
  maxRoomsPerConnection: 100,
  maxMembersPerRoom: 10_000,
  maxNamespacesPerTenant: 1_000,
  maxRoomMetadataSizeBytes: 4_096,
  maxJoinAttemptsPerMinute: 60,
  maxFanoutConcurrency: 1_000,
};

// ---------------------------------------------------------------------------
// Storage interface
// ---------------------------------------------------------------------------

/**
 * Storage interface for namespace, room, and membership state.
 * Multi-instance deployments share this store via a backend (Redis, etc.).
 */
export interface RoomNamespaceStore {
  // Namespace operations
  getNamespace(tenantId: string, namespaceId: string): Promise<NamespaceRecord | null>;
  createNamespace(record: NamespaceRecord): Promise<void>;
  deleteNamespace(tenantId: string, namespaceId: string): Promise<void>;
  listNamespaces(tenantId: string): Promise<NamespaceRecord[]>;

  // Room operations
  getRoom(roomKey: string): Promise<RoomRecord | null>;
  createRoom(record: RoomRecord): Promise<void>;
  deleteRoom(roomKey: string): Promise<void>;
  listRooms(tenantId: string, namespaceId: string): Promise<RoomRecord[]>;

  // Membership operations
  getMembership(roomKey: string, connectionId: string): Promise<Membership | null>;
  getMembers(roomKey: string): Promise<Membership[]>;
  getMemberCount(roomKey: string): Promise<number>;
  getConnectionsForUser(userId: string, tenantId: string): Promise<string[]>;
  addMembership(membership: Membership): Promise<void>;
  removeMembership(roomKey: string, connectionId: string): Promise<void>;
  removeAllMembershipsForConnection(connectionId: string): Promise<void>;

  // Room-key index
  getRoomsForConnection(connectionId: string): Promise<string[]>;
}

/**
 * Authorization callback for room:join.
 */
export type AuthorizeJoin = (
  principal: { userId: string; tenantId: string },
  roomKey: string,
  roomRecord: RoomRecord,
) => Promise<boolean> | boolean;

/**
 * Authorization callback for room:publish.
 */
export type AuthorizePublish = (
  principal: { userId: string; tenantId: string },
  roomKey: string,
  roomRecord: RoomRecord,
) => Promise<boolean> | boolean;

// ---------------------------------------------------------------------------
// Encryption epoch
// ---------------------------------------------------------------------------

/**
 * Key epoch for E2EE room encryption. Advanced on revocation/rekey.
 */
export interface KeyEpoch {
  roomKey: string;
  epoch: number;
  validFrom: number;
}

/**
 * Check whether a client key registration is current for a room epoch.
 */
export type IsKeyCurrent = (
  roomKey: string,
  userId: string,
  epoch: number,
) => Promise<boolean> | boolean;
