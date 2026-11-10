/**
 * Error registry, mapper, and serializer.
 *
 * The registry is the single source of truth mapping internal failures to
 * the public `ErrorCode` contract (docs/error/error-handling.md §6).
 *
 * - Each internal error class has exactly one registry mapping.
 * * Unknown exceptions map to `INTERNAL` with an opaque client message.
 * - `mapError()` converts any thrown value to a `PublicError`.
 * - `toPublicError()` / `serializePublicError()` emit only the allowlisted
 *   public fields; stack traces, secrets, and raw `details` never reach
 *   clients.
 */

import type { ErrorCode, ErrorRegistryEntry, ErrorRegistryMapping, PublicError } from "./types.js";
import {
  AuthenticationTimeoutError,
  CleanupError,
  ConnectionClosedError,
  ConnectionLimitError,
  ConnectionNotAuthenticatedError,
  CrdtInvalidOperationError,
  DeliveryFailedError,
  DocumentError,
  DocumentForbiddenError,
  DocumentNotFoundError,
  EventTimeoutError,
  ForbiddenError,
  HandshakeOriginRejectedError,
  HandshakeTimeoutError,
  HandshakeUnauthorizedError,
  HostIntegrationInvalidError,
  MessageTooLargeError,
  NamespaceNotFoundError,
  OverloadedError,
  PublicUrlRequiredError,
  RateLimitedError,
  RealtimeAlreadyStartedError,
  RealtimeStartCancelledError,
  RoomCapacityError,
  RoomError,
  RoomFullError,
  RoomNotFoundError,
  SendBackpressuredError,
  TenantIsolationError,
  UwsListenFailedError,
  UwsModuleNotFoundError,
  UwsUnsupportedRuntimeError,
  UnauthenticatedError,
  ValidationFailedError,
  VersionUnsupportedError,
  RetryExhaustedError,
} from "./hub-error.js";

export type { ErrorCode, ErrorRegistryEntry, ErrorRegistryMapping, PublicError };

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Registry: authoritative mapping from internal failures to public contract.
 */
export class ErrorRegistry {
  private readonly byClass = new Map<new (...args: any[]) => any, ErrorRegistryEntry>();
  private readonly fallbacks: Array<{ predicate: (error: unknown) => boolean; entry: ErrorRegistryEntry }> = [];

  register(mapping: ErrorRegistryMapping): void {
    if (mapping.errorClass) {
      this.byClass.set(mapping.errorClass, mapping.entry);
    }
    if (mapping.predicate) {
      this.fallbacks.push({ predicate: mapping.predicate, entry: mapping.entry });
    }
  }

  lookup(error: unknown): ErrorRegistryEntry {
    if (error instanceof Error) {
      const byClassEntry = this.byClass.get(error.constructor as new (...args: any[]) => any);
      if (byClassEntry) {
        return byClassEntry;
      }
      for (const { predicate, entry } of this.fallbacks) {
        if (predicate(error)) {
          return entry;
        }
      }
    }
    return internalEntry;
  }
}

const internalEntry: ErrorRegistryEntry = {
  code: "INTERNAL",
  defaultMessage: "An internal error occurred.",
  retryable: false,
};

export const globalRegistry = new ErrorRegistry();

function registerInternal(
  code: ErrorCode,
  defaultMessage: string,
  options?: { retryable?: boolean; retryAfterMs?: number },
): ErrorRegistryEntry {
  return {
    code,
    defaultMessage,
    retryable: options?.retryable ?? false,
    retryAfterMs: options?.retryAfterMs,
  };
}

// ---------------------------------------------------------------------------
// Default registry mappings (docs/error/error-handling.md §6.1)
// ---------------------------------------------------------------------------

const entry = (
  code: ErrorCode,
  message: string,
  options?: { retryable?: boolean; retryAfterMs?: number },
) => registerInternal(code, message, options);

// Auth & access
globalRegistry.register({
  errorClass: UnauthenticatedError,
  entry: entry("UNAUTHENTICATED", "Not authenticated.", { retryable: false }),
});
globalRegistry.register({
  errorClass: ForbiddenError,
  entry: entry("FORBIDDEN", "Not authorized.", { retryable: false }),
});
globalRegistry.register({
  errorClass: TenantIsolationError,
  entry: entry("FORBIDDEN", "Tenant isolation violation.", { retryable: false }),
});

// Input & protocol
globalRegistry.register({
  errorClass: ValidationFailedError,
  entry: entry("VALIDATION_FAILED", "Request validation failed.", { retryable: false }),
});
globalRegistry.register({
  errorClass: MessageTooLargeError,
  entry: entry("MESSAGE_TOO_LARGE", "Message exceeds the size limit.", { retryable: false }),
});
globalRegistry.register({
  errorClass: VersionUnsupportedError,
  entry: entry("VERSION_UNSUPPORTED", "Protocol version is unsupported. Resync or upgrade the client.", { retryable: false }),
});

// Capacity & limits
globalRegistry.register({
  errorClass: RateLimitedError,
  entry: entry("RATE_LIMITED", "Rate limit exceeded. Try again later.", { retryable: true }),
});
globalRegistry.register({
  errorClass: ConnectionLimitError,
  entry: entry("CONNECTION_LIMIT", "Connection limit reached.", { retryable: false }),
});
globalRegistry.register({
  errorClass: RoomFullError,
  entry: entry("ROOM_FULL", "Room is at capacity.", { retryable: false }),
});
globalRegistry.register({
  errorClass: RoomCapacityError,
  entry: entry("ROOM_FULL", "Room is at capacity.", { retryable: false }),
});
globalRegistry.register({
  errorClass: OverloadedError,
  entry: entry("OVERLOADED", "Service is temporarily overloaded.", { retryable: true, retryAfterMs: 1000 }),
});

// Resource existence
globalRegistry.register({
  errorClass: RoomNotFoundError,
  entry: entry("ROOM_NOT_FOUND", "Room not found.", { retryable: false }),
});
globalRegistry.register({
  errorClass: NamespaceNotFoundError,
  entry: entry("NAMESPACE_NOT_FOUND", "Namespace not found.", { retryable: false }),
});
globalRegistry.register({
  errorClass: DocumentNotFoundError,
  entry: entry("DOCUMENT_NOT_FOUND", "Document not found.", { retryable: false }),
});

// Connection lifecycle
globalRegistry.register({
  errorClass: ConnectionClosedError,
  entry: entry("CONNECTION_CLOSED", "Connection is closed.", { retryable: false }),
});

// Delivery & async work
globalRegistry.register({
  errorClass: EventTimeoutError,
  entry: entry("EVENT_TIMEOUT", "Operation timed out.", { retryable: false }),
});
globalRegistry.register({
  errorClass: DeliveryFailedError,
  entry: entry("DELIVERY_FAILED", "Delivery failed.", { retryable: true }),
});
globalRegistry.register({
  errorClass: RetryExhaustedError,
  entry: entry("RETRY_EXHAUSTED", "Retry budget exhausted.", { retryable: false }),
});

// Collaboration / CRDT
globalRegistry.register({
  errorClass: DocumentForbiddenError,
  entry: entry("DOCUMENT_FORBIDDEN", "Document access is forbidden.", { retryable: false }),
});
globalRegistry.register({
  errorClass: CrdtInvalidOperationError,
  entry: entry("CRDT_INVALID_OPERATION", "Invalid CRDT operation.", { retryable: false }),
});

// Document / room (generic)
globalRegistry.register({
  errorClass: DocumentError,
  entry: entry("INTERNAL", "Document error.", { retryable: false }),
});
globalRegistry.register({
  errorClass: RoomError,
  entry: entry("INTERNAL", "Room error.", { retryable: false }),
});

// Cleanup
globalRegistry.register({
  errorClass: CleanupError,
  entry: entry("INTERNAL", "Cleanup encountered errors.", { retryable: false }),
});

// Transport / uWebSockets (docs/architecture-consolidation-uws-plan-v2.md §9.7)
globalRegistry.register({
  errorClass: UwsModuleNotFoundError,
  entry: entry("UWS_MODULE_NOT_FOUND", "uWebSockets.js native module could not be loaded.", { retryable: false }),
});
globalRegistry.register({
  errorClass: UwsUnsupportedRuntimeError,
  entry: entry("UWS_UNSUPPORTED_RUNTIME", "Current runtime/platform is not supported by the pinned uWebSockets.js build.", { retryable: false }),
});
globalRegistry.register({
  errorClass: UwsListenFailedError,
  entry: entry("UWS_LISTEN_FAILED", "uWebSockets.js could not bind to the configured address.", { retryable: false }),
});
globalRegistry.register({
  errorClass: HandshakeUnauthorizedError,
  entry: entry("HANDSHAKE_UNAUTHORIZED", "Handshake authentication failed.", { retryable: false }),
});
globalRegistry.register({
  errorClass: HandshakeOriginRejectedError,
  entry: entry("HANDSHAKE_ORIGIN_REJECTED", "Browser origin is not allowed.", { retryable: false }),
});
globalRegistry.register({
  errorClass: HandshakeTimeoutError,
  entry: entry("HANDSHAKE_TIMEOUT", "Authentication/handshake deadline expired.", { retryable: false }),
});
globalRegistry.register({
  errorClass: SendBackpressuredError,
  entry: entry("SEND_BACKPRESSURED", "Local send path cannot accept more data under current policy.", { retryable: true }),
});

// Lifecycle
globalRegistry.register({
  errorClass: RealtimeAlreadyStartedError,
  entry: entry("REALTIME_ALREADY_STARTED", "Realtime server is already started.", { retryable: false }),
});
globalRegistry.register({
  errorClass: RealtimeStartCancelledError,
  entry: entry("REALTIME_START_CANCELLED", "Realtime start was cancelled during shutdown.", { retryable: false }),
});

// Host / integration
globalRegistry.register({
  errorClass: HostIntegrationInvalidError,
  entry: entry("HOST_INTEGRATION_INVALID", "Host integration configuration is invalid.", { retryable: false }),
});
globalRegistry.register({
  errorClass: PublicUrlRequiredError,
  entry: entry("PUBLIC_URL_REQUIRED", "Proxy mode requires an externally configured publicUrl.", { retryable: false }),
});

// ---------------------------------------------------------------------------
// Mapper / serializer
// ---------------------------------------------------------------------------

/** Generate / validate a correlation request id. */
export function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Map any thrown value to a `PublicError`. Preserves an already-registered
 * `HubError` mapping; unknown exceptions map to `INTERNAL`.
 * Never serializes the raw exception.
 */
export function mapError(
  error: unknown,
  options?: { requestId?: string; registry?: ErrorRegistry },
): PublicError {
  const registry = options?.registry ?? globalRegistry;
  const requestId = options?.requestId ?? generateRequestId();
  const entry = registry.lookup(error);

  // The client receives the safe default message from the registry, never
  // the raw error message (which may leak internals).
  const message = entry.defaultMessage;

  return toPublicError(entry.code, message, entry.retryable, {
    requestId,
    retryAfterMs: errorRetryAfterMs(error) ?? entry.retryAfterMs,
  });
}

/** Preferred `retryAfterMs` from the error, falling back to undefined. */
function errorRetryAfterMs(error: unknown): number | undefined {
  if (error instanceof Error && "retryAfterMs" in error) {
    const v = (error as { retryAfterMs: unknown }).retryAfterMs;
    return typeof v === "number" ? v : undefined;
  }
  return undefined;
}

/** Allowlist serializer: only public fields are emitted. */
export function toPublicError(
  code: ErrorCode,
  message: string,
  retryable: boolean,
  options?: { requestId?: string; retryAfterMs?: number; cause?: unknown },
): PublicError {
  const publicError: PublicError = {
    code,
    message: String(message),
    retryable: Boolean(retryable),
  };
  if (options?.requestId) {
    publicError.requestId = options.requestId;
  }
  if (options?.retryAfterMs !== undefined && options.retryAfterMs !== null) {
    publicError.retryAfterMs = options.retryAfterMs;
  }
  return publicError;
}

/** Serialize a PublicError to a safe JSON object (allowlist only). */
export function serializePublicError(error: PublicError): Record<string, unknown> {
  const out: Record<string, unknown> = {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
  if (error.requestId !== undefined) {
    out.requestId = error.requestId;
  }
  if (error.retryAfterMs !== undefined) {
    out.retryAfterMs = error.retryAfterMs;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

// All symbols above are already exported inline (classes, consts, functions).
// The types are re-exported via the index barrel.

