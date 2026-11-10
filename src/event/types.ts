/**
 * Event Management and Delivery types.
 *
 * Implements docs/event/event-management.md and
 * docs/event/event-management-delivery-architecture-plan.md:
 *
 * - Validated, authorized routing of application messages.
 * - Ephemeral (best-effort, no retry) and at-least-once (bounded retry,
 *   stable messageId) delivery modes.
 * - Per-recipient delivery state machine: created → accepted → queued →
 *   written → received → processed, with failed / expired terminals.
 * - Stable messageId across retries; idempotent duplicate publish/ACK.
 * - Authenticated ACKs (received / processed), connection-bound.
 * - Partial fan-out results (accepted / failed / pending).
 * - E2EE-transparent: payload is treated as opaque ciphertext; never
 *   decrypted here.
 */

// ---------------------------------------------------------------------------
// Delivery mode
// ---------------------------------------------------------------------------

export type DeliveryMode = "ephemeral" | "at-least-once";

// ---------------------------------------------------------------------------
// Event envelope
// ---------------------------------------------------------------------------

/**
 * Every routed message is wrapped in this envelope. The event subsystem
 * validates the outer envelope and routes bytes; it never decrypts the
 * payload (E2EE payloads pass through as ciphertext).
 */
export interface EventEnvelope<Payload = unknown> {
  protocolVersion: number;
  messageId: string;
  event: string;
  senderConnectionId: string;
  senderUserId: string;
  namespace: string;
  roomId?: string;
  createdAt: number;
  expiresAt?: number;
  delivery: DeliveryMode;
  payload: Payload;
}

/** Current event protocol version. Reject anything else. */
import { PROTOCOL_VERSION } from "../protocol/types.js";

export const EVENT_PROTOCOL_VERSION = PROTOCOL_VERSION;

// ---------------------------------------------------------------------------
// Publish options / result
// ---------------------------------------------------------------------------

export interface PublishOptions {
  delivery?: DeliveryMode;
  timeoutMs?: number;
  idempotencyKey?: string;
  excludeSender?: boolean;
}

/**
 * Partial fan-out results. Never collapse into a single boolean success.
 */
export interface PublishResult {
  messageId: string;
  accepted: number;
  failed: number;
  pending: number;
}

// ---------------------------------------------------------------------------
// Delivery state machine
// ---------------------------------------------------------------------------

export type DeliveryState =
  | "created"
  | "accepted"
  | "queued"
  | "written"
  | "received"
  | "processed"
  | "failed"
  | "expired";

// ---------------------------------------------------------------------------
// Delivery record (per recipient connection)
// ---------------------------------------------------------------------------

export interface DeliveryRecord {
  messageId: string;
  recipientConnectionId: string;
  state: DeliveryState;
  attempts: number;
  deadlineAt: number;
}

// ---------------------------------------------------------------------------
// ACK shape (single documented ACK API)
// ---------------------------------------------------------------------------

export interface DeliveryAck {
  messageId: string;
  recipientConnectionId: string;
  kind: "received" | "processed";
}

// ---------------------------------------------------------------------------
// Event options / policy
// ---------------------------------------------------------------------------

export interface EventConfig {
  /** Default protocol version. */
  protocolVersion?: number;
  /** Default TTL for at-least-once events (ms). Default 300000 (5 min). */
  defaultTtlMs?: number;
  /** Max payload size in bytes. Default 256 KiB. */
  maxPayloadBytes?: number;
  /** Max fan-out concurrency per publish. Default 64. */
  maxFanoutConcurrency?: number;
  /** Per-client queue byte limit. Default 256 KiB. */
  maxQueuedBytesPerConnection?: number;
  /** Max retry attempts for at-least-once. Default 5. */
  maxRetryAttempts?: number;
  /** Base retry delay ms. Default 150. */
  baseRetryDelayMs?: number;
  /** Max retry delay ms. Default 15000. */
  maxRetryDelayMs?: number;
  /** Whether delivery tracking (delivery records) is enabled. Default true. */
  enableTracking?: boolean;
}

export const DEFAULT_EVENT_CONFIG: Readonly<EventConfig> = Object.freeze({
  protocolVersion: EVENT_PROTOCOL_VERSION,
  defaultTtlMs: 300_000,
  maxPayloadBytes: 256 * 1024,
  maxFanoutConcurrency: 64,
  maxQueuedBytesPerConnection: 256 * 1024,
  maxRetryAttempts: 5,
  baseRetryDelayMs: 150,
  maxRetryDelayMs: 15_000,
  enableTracking: true,
});

// ---------------------------------------------------------------------------
// Event accessor injected from Core Hub
// ---------------------------------------------------------------------------

/** Minimal view of an authenticated connection supplied by Core Hub. */
export interface HubConnectionView {
  connectionId: string;
  state: string;
  principal?: {
    userId: string;
    tenantId: string;
    roles: readonly string[];
    sessionId: string;
  } | undefined;
  transport: { id: string; send(data: Uint8Array): Promise<void> };
}

/** Membership + authorization access supplied by Core Hub. */
export interface HubMembershipAccess {
  members(roomId: string): string[];
  count(roomId: string): number;
  rooms(connectionId: string): string[];
  has(connectionId: string, roomId: string): boolean;
}

/** Authorization hook supplied by Core Hub. */
export interface HubAuthorize {
  (
    action: string,
    principal: { userId: string; tenantId: string; roles: readonly string[]; sessionId: string },
    resourceId?: string,
    tenantId?: string,
  ): boolean | Promise<boolean>;
}
