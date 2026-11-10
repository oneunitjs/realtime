/**
 * Typed internal errors.
 *
 * Single error contract used by the Core Hub, E2EE layer, and error-contract
 * machinery. Every subclass maps through the registry to exactly one public
 * code (docs/error/error-handling.md §2.2).
 */

import type { ErrorCode } from "./types.js";

// ---------------------------------------------------------------------------
// HubError base (docs/error/error-handling.md §2.2)
// ---------------------------------------------------------------------------

export class HubError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      retryable?: boolean;
      retryAfterMs?: number;
      details?: unknown;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.retryAfterMs = options?.retryAfterMs;
    this.details = options?.details;
  }
}

// ---------------------------------------------------------------------------
// HubError subclasses — shared / new contract
// ---------------------------------------------------------------------------

export class UnauthenticatedError extends HubError {
  constructor(message = "Not authenticated", options?: { details?: unknown; cause?: unknown }) {
    super("UNAUTHENTICATED", message, { details: options?.details, cause: options?.cause });
  }
}

export class ForbiddenError extends HubError {
  constructor(message = "Not authorized", options?: { details?: unknown; cause?: unknown }) {
    super("FORBIDDEN", message, { details: options?.details, cause: options?.cause });
  }
}

export class ValidationFailedError extends HubError {
  constructor(message = "Request validation failed", options?: { details?: unknown; cause?: unknown }) {
    super("VALIDATION_FAILED", message, { details: options?.details, cause: options?.cause });
  }
}

export class MessageTooLargeError extends HubError {
  readonly size: number;
  readonly limit: number;
  constructor(size: number, limit: number, options?: { cause?: unknown }) {
    super("MESSAGE_TOO_LARGE", `Message of ${size} bytes exceeds the ${limit} byte limit`, {
      cause: options?.cause,
    });
    this.size = size;
    this.limit = limit;
  }
}

export class VersionUnsupportedError extends HubError {
  constructor(message = "Protocol version is unsupported", options?: { cause?: unknown }) {
    super("VERSION_UNSUPPORTED", message, { cause: options?.cause });
  }
}

export class RateLimitedError extends HubError {
  readonly retryAfterMs?: number;
  constructor(message = "Rate limit exceeded", options?: { retryAfterMs?: number; cause?: unknown }) {
    super("RATE_LIMITED", message, { retryable: true, cause: options?.cause });
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export class ConnectionLimitError extends HubError {
  readonly limit: number;
  constructor(message = "Connection limit reached", limit: number, options?: { cause?: unknown }) {
    super("CONNECTION_LIMIT", message, { cause: options?.cause });
    this.limit = limit;
  }
}

export class RoomFullError extends HubError {
  readonly roomId?: string;
  constructor(message = "Room is at capacity", options?: { roomId?: string; cause?: unknown }) {
    super("ROOM_FULL", message, { cause: options?.cause });
    this.roomId = options?.roomId;
  }
}

export class OverloadedError extends HubError {
  readonly retryAfterMs?: number;
  constructor(message = "Service is temporarily overloaded", options?: { retryAfterMs?: number; cause?: unknown }) {
    super("OVERLOADED", message, { retryable: true, retryAfterMs: options?.retryAfterMs, cause: options?.cause });
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export class RoomNotFoundError extends HubError {
  readonly roomId?: string;
  constructor(message = "Room not found", options?: { roomId?: string; cause?: unknown }) {
    super("ROOM_NOT_FOUND", message, { cause: options?.cause });
    this.roomId = options?.roomId;
  }
}

export class NamespaceNotFoundError extends HubError {
  readonly namespace?: string;
  constructor(message = "Namespace not found", options?: { namespace?: string; cause?: unknown }) {
    super("NAMESPACE_NOT_FOUND", message, { cause: options?.cause });
    this.namespace = options?.namespace;
  }
}

export class DocumentNotFoundError extends HubError {
  readonly documentId?: string;
  constructor(message = "Document not found", options?: { documentId?: string; cause?: unknown }) {
    super("DOCUMENT_NOT_FOUND", message, { cause: options?.cause });
    this.documentId = options?.documentId;
  }
}

export class ConnectionClosedError extends HubError {
  constructor(message = "Connection is closed", options?: { cause?: unknown }) {
    super("CONNECTION_CLOSED", message, { cause: options?.cause });
  }
}

export class EventTimeoutError extends HubError {
  constructor(message = "Operation timed out", options?: { cause?: unknown }) {
    super("EVENT_TIMEOUT", message, { cause: options?.cause });
  }
}

export class DeliveryFailedError extends HubError {
  constructor(message = "Delivery failed", options?: { retryable?: boolean; cause?: unknown }) {
    super("DELIVERY_FAILED", message, { retryable: options?.retryable ?? true, cause: options?.cause });
  }
}

export class RetryExhaustedError extends HubError {
  readonly lastError: unknown;
  readonly attempts: number;
  constructor(message = "Retry budget exhausted", lastError: unknown, attempts: number) {
    super("RETRY_EXHAUSTED", message, { cause: lastError });
    this.lastError = lastError;
    this.attempts = attempts;
  }
}

export class DocumentForbiddenError extends HubError {
  readonly documentId?: string;
  constructor(message = "Document access is forbidden", options?: { documentId?: string; cause?: unknown }) {
    super("DOCUMENT_FORBIDDEN", message, { cause: options?.cause });
    this.documentId = options?.documentId;
  }
}

export class CrdtInvalidOperationError extends HubError {
  constructor(message = "Invalid CRDT operation", options?: { cause?: unknown }) {
    super("CRDT_INVALID_OPERATION", message, { cause: options?.cause });
  }
}

export class TenantIsolationError extends HubError {
  constructor(message = "Tenant isolation violation", options?: { cause?: unknown }) {
    super("FORBIDDEN", message, { cause: options?.cause });
  }
}

export class RoomCapacityError extends HubError {
  readonly limit: number;
  constructor(message: string, limit: number, roomId?: string) {
    super("ROOM_FULL", message);
    this.limit = limit;
  }
}

export class DocumentError extends HubError {
  readonly documentId?: string;
  constructor(message: string, options?: { documentId?: string; cause?: unknown }) {
    super("INTERNAL", message, { cause: options?.cause });
    this.documentId = options?.documentId;
  }
}

export class RoomError extends HubError {
  readonly roomId?: string;
  constructor(message: string, options?: { roomId?: string; cause?: unknown; code?: ErrorCode }) {
    super(options?.code ?? "INTERNAL", message, { cause: options?.cause });
    this.roomId = options?.roomId;
  }
}

export class CleanupError extends HubError {
  readonly errors: unknown[];
  constructor(message: string, errors: unknown[]) {
    super("INTERNAL", message);
    this.errors = errors;
  }
}

export class AuthenticationTimeoutError extends HubError {
  constructor(message = "Authentication deadline exceeded", options?: { cause?: unknown }) {
    super("UNAUTHENTICATED", message, { cause: options?.cause });
  }
}

export class ConnectionNotAuthenticatedError extends HubError {
  readonly connectionId: string | undefined;
  constructor(connectionId?: string) {
    super("UNAUTHENTICATED", "Connection is not authenticated");
    this.connectionId = connectionId;
  }
}

// ---------------------------------------------------------------------------
// Transport / uWebSockets errors (docs/architecture-consolidation-uws-plan-v2.md §9.7)
// ---------------------------------------------------------------------------

export class UwsModuleNotFoundError extends HubError {
  constructor(options?: { cause?: unknown }) {
    super("UWS_MODULE_NOT_FOUND", "uWebSockets.js native module could not be loaded.", {
      cause: options?.cause,
    });
  }
}

export class UwsUnsupportedRuntimeError extends HubError {
  constructor(options?: { cause?: unknown }) {
    super("UWS_UNSUPPORTED_RUNTIME", "Current runtime/platform is not supported by the pinned uWebSockets.js build.", {
      cause: options?.cause,
    });
  }
}

export class UwsListenFailedError extends HubError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("UWS_LISTEN_FAILED", message, { cause: options?.cause });
  }
}

export class RealtimeAlreadyStartedError extends HubError {
  constructor(message = "Realtime server is already started", options?: { cause?: unknown }) {
    super("REALTIME_ALREADY_STARTED", message, { cause: options?.cause });
  }
}

export class RealtimeStartCancelledError extends HubError {
  constructor(message = "Realtime start was cancelled during shutdown", options?: { cause?: unknown }) {
    super("REALTIME_START_CANCELLED", message, { cause: options?.cause });
  }
}

export class HandshakeUnauthorizedError extends HubError {
  constructor(message = "Handshake authentication failed", options?: { cause?: unknown }) {
    super("HANDSHAKE_UNAUTHORIZED", message, { cause: options?.cause });
  }
}

export class HandshakeOriginRejectedError extends HubError {
  constructor(message = "Browser origin is not allowed", options?: { cause?: unknown }) {
    super("HANDSHAKE_ORIGIN_REJECTED", message, { cause: options?.cause });
  }
}

export class HandshakeTimeoutError extends HubError {
  constructor(message = "Authentication/handshake deadline expired", options?: { cause?: unknown }) {
    super("HANDSHAKE_TIMEOUT", message, { cause: options?.cause });
  }
}

export class SendBackpressuredError extends HubError {
  constructor(message = "Local send path cannot accept more data under current policy", options?: { cause?: unknown }) {
    super("SEND_BACKPRESSURED", message, { retryable: true, cause: options?.cause });
  }
}

export class HostIntegrationInvalidError extends HubError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("HOST_INTEGRATION_INVALID", message, { cause: options?.cause });
  }
}

export class PublicUrlRequiredError extends HubError {
  constructor(message = "Proxy mode requires an externally configured publicUrl", options?: { cause?: unknown }) {
    super("PUBLIC_URL_REQUIRED", message, { cause: options?.cause });
  }
}
