/**
 * Rooms and Namespaces — Public API exports.
 *
 * Re-exports all public types, services, and utilities from the rooms and
 * namespaces subsystem.
 *
 * Module structure:
 *   @oneunit/realtime/room-namespace        — Full rooms/namespaces API
 *   @oneunit/realtime/room-namespace/types   — Type definitions only
 *   @oneunit/realtime/room-namespace/router   — Room/Namespace router
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  NamespaceRecord,
  RoomRecord,
  Membership,
  EncryptionPolicy,
  JoinResult,
  PublishResult,
  LeaveResult,
  RoomErrorCode,
  RoomError,
  RoomNamespaceLimits,
  RoomNamespaceStore,
  AuthorizeJoin,
  AuthorizePublish,
  IsKeyCurrent,
  KeyEpoch,
} from "./types.js";

export { DEFAULT_ROOM_NAMESPACE_LIMITS } from "./types.js";

// ---------------------------------------------------------------------------
// Room key encoding
// ---------------------------------------------------------------------------

export {
  encodeRoomKey,
  decodeRoomKey,
  isValidRoomKey,
  encodeNamespaceKey,
  decodeNamespaceKey,
} from "./room-key.js";

// ---------------------------------------------------------------------------
// Managers
// ---------------------------------------------------------------------------

export { NamespaceManager } from "./namespace-manager.js";

export { RoomManager } from "./room-manager.js";

export { MembershipManager } from "./membership-manager.js";

export { EncryptionGate } from "./encryption-gate.js";

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export {
  RoomNamespaceRouter,
  type OnPresenceUpdate,
  type OnEventPublish,
  type OnFanout,
} from "./router.js";

// ---------------------------------------------------------------------------
// Transport

