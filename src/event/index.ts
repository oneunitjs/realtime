/**
 * Event Management and Delivery public surface.
 *
 * Implements docs/event/event-management.md and
 * docs/event/event-management-delivery-architecture-plan.md:
 *
 * - `EventService` — validated, authorized event publishing with optional
 *   per-recipient delivery tracking.
 * - `EventEnvelope`, `PublishOptions`, `PublishResult`, `DeliveryRecord`,
 *   `DeliveryAck`, `DeliveryMode`, `DeliveryState`.
 * - Envelope builder, bounded fan-out scheduler, ACK handler, delivery
 *   state machine + store.
 *
 * All failures map through the shared Error Handling registry
 * (docs/error/error-handling.md).
 */

export {
  EventService,
  type EventServiceDeps,
} from "./service.js";

export type {
  EventConfig,
  EventEnvelope,
  PublishOptions,
  PublishResult,
  DeliveryMode,
  DeliveryState,
  DeliveryRecord,
  DeliveryAck,
  HubConnectionView,
  HubMembershipAccess,
  HubAuthorize,
} from "./types.js";

export { DEFAULT_EVENT_CONFIG, EVENT_PROTOCOL_VERSION } from "./types.js";

export {
  EnvelopeBuilder,
  type EnvelopeInput,
} from "./envelope.js";

export {
  FanoutScheduler,
  type FanoutRecipient,
  type FanoutOptions,
} from "./fanout.js";

export {
  AckHandler,
  type AckResult,
} from "./ack.js";

export {
  canTransition,
  transitionName,
} from "./delivery-state.js";
export type { DeliveryTransition } from "./delivery-state.js";
export type { DeliveryRecordStore } from "./delivery-state.js";
export {
  MemoryDeliveryRecordStore,
  deliveryRecordKey,
} from "./delivery-state.js";
