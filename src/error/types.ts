/**
 * Shared error-contract types.
 *
 * Single source of truth for the public `ErrorCode` taxonomy, the
 * client-visible `PublicError` shape, and the registry/serializer types.
 * Implements docs/error/error-handling.md and
 * docs/error/error-handling-architecture-plan.md.
 */

// ---------------------------------------------------------------------------
// ErrorCode taxonomy (docs/error/error-handling.md §2.1)
// ---------------------------------------------------------------------------

export type ErrorCode =
  // Auth & access
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "HANDSHAKE_UNAUTHORIZED"
  | "HANDSHAKE_ORIGIN_REJECTED"
  | "HANDSHAKE_TIMEOUT"
  // Input & protocol
  | "VALIDATION_FAILED"
  | "MESSAGE_TOO_LARGE"
  | "VERSION_UNSUPPORTED"
  // Capacity & limits
  | "RATE_LIMITED"
  | "CONNECTION_LIMIT"
  | "ROOM_FULL"
  | "OVERLOADED"
  // Resource existence
  | "ROOM_NOT_FOUND"
  | "NAMESPACE_NOT_FOUND"
  | "DOCUMENT_NOT_FOUND"
  // Connection lifecycle
  | "CONNECTION_CLOSED"
  | "SEND_BACKPRESSURED"
  // Delivery & async work
  | "EVENT_TIMEOUT"
  | "DELIVERY_FAILED"
  | "RETRY_EXHAUSTED"
  // Collaboration / CRDT
  | "DOCUMENT_FORBIDDEN"
  | "CRDT_INVALID_OPERATION"
  // Transport / uWebSockets
  | "UWS_MODULE_NOT_FOUND"
  | "UWS_UNSUPPORTED_RUNTIME"
  | "UWS_LISTEN_FAILED"
  // Lifecycle
  | "REALTIME_ALREADY_STARTED"
  | "REALTIME_START_CANCELLED"
  // Host / integration
  | "HOST_INTEGRATION_INVALID"
  | "PUBLIC_URL_REQUIRED"
  // Catch-all
  | "INTERNAL";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * The only error shape a client may receive. Serialization is allowlisted;
 * nothing else (stack traces, secrets, raw details, ciphertext) is ever
 * included.
 */
export interface PublicError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  requestId?: string;
  retryAfterMs?: number;
}

/** Correlation context propagated through Hub, Collaboration Engine, and logs. */
export interface CorrelationContext {
  requestId: string;
  connectionId?: string;
  tenantId?: string;
  operation?: string;
  resourceId?: string;
}

// ---------------------------------------------------------------------------
// Registry types
// ---------------------------------------------------------------------------

export interface ErrorRegistryEntry {
  /** Public code this internal failure maps to. */
  code: ErrorCode;
  /** Safe default client message. */
  defaultMessage: string;
  /** Whether clients may retry. */
  retryable: boolean;
  /** Lower bound before the next retry attempt, when known. */
  retryAfterMs?: number;
}

/** A registered internal error constructor plus its mapping. */
export interface ErrorRegistryMapping {
  /** Internal error class (or `undefined` for unknown-exception fallback). */
  errorClass?: new (...args: any[]) => any;
  /** Fallback predicate when no class matches. */
  predicate?: (error: unknown) => boolean;
  entry: ErrorRegistryEntry;
}
