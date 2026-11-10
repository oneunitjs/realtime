/**
 * Presence Management — Public API exports.
 *
 * Re-exports all public types, services, and utilities from the presence
 * subsystem. Individual modules can be imported directly for finer-grained
 * control.
 *
 * Module structure:
 *   @oneunit/realtime/presence        — Full presence API
 *   @oneunit/realtime/presence/types   — Type definitions only
 *   @oneunit/realtime/presence/service — PresenceService
 *   @oneunit/realtime/presence/storage — Storage adapters
 *   @oneunit/realtime/presence/router  — REST + WebSocket routing
 *   @oneunit/realtime/presence/sdk     — TypeScript client SDK
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  DeviceStatus,
  DevicePresence,
  UserPresence,
  InternalDeviceLease,
  PresenceRoomMembership,
  PresenceSubscription,
  AwarenessEvent,
  AwarenessTypingStart,
  AwarenessTypingStop,
  AwarenessTypingUpdated,
  AwarenessCursorUpdate,
  AwarenessCursorUpdated,
  PresenceUserUpdated,
  PresenceRoomUpdated,
  PresenceSystemEvent,
  AuthenticatedPrincipal,
  ConnectionContext,
  CursorPayload,
  PresenceErrorCode,
  PresenceConfig,
  PresenceStore,
} from "./types.js";

export { DEFAULT_PRESENCE_CONFIG } from "./types.js";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export {
  InMemoryPresenceStore,
  RedisPresenceStore,
} from "./storage.js";

// ---------------------------------------------------------------------------
// Managers
// ---------------------------------------------------------------------------

export {
  calculateUserStatus,
  buildUserPresence,
  presenceChanged,
} from "./aggregation-manager.js";

export {
  createLease,
  refreshLease,
  isLeaseExpired,
  isLeaseValid,
  leaseToDevicePresence,
  calculateAggregate,
} from "./lease-manager.js";

export { ExpiryManager } from "./expiry-manager.js";

export {
  AuthorizationManager,
  createDefaultAuthorizationManager,
} from "./authorization-manager.js";

export {
  PresenceEventPublisher,
  createInMemoryEventPublisher,
} from "./event-publisher.js";

export { AwarenessManager } from "./awareness-manager.js";

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export { PresenceService } from "./service.js";

// ---------------------------------------------------------------------------
// Hub Integration
// ---------------------------------------------------------------------------

export {
  HubPresenceIntegration,
  createHubWithPresence,
  type HubPresenceOptions,
} from "./hub-integration.js";

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export {
  PresenceRouter,
  type PresenceRequest,
  type PresenceResponse,
} from "./router.js";

// ---------------------------------------------------------------------------
// SDK
// ---------------------------------------------------------------------------

export {
  PresenceClient,
  PresenceRoom,
  type PresenceClientOptions,
} from "./sdk.js";


