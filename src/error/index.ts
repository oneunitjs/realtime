/**
 * Single error-contract folder.
 *
 * Merges the former `src/errors/`, `src/core/errors/`, and `src/error-contract/`
 * locations into one source of truth, plus the shared `Logger` interface.
 *
 * Implements docs/error/error-handling.md and
 * docs/error/error-handling-architecture-plan.md.
 */

export { ConsoleLogger, SilentLogger } from "./logger.js";
export type { Logger } from "./logger.js";

export type {
  ErrorCode,
  PublicError,
  ErrorRegistryEntry,
  ErrorRegistryMapping,
  CorrelationContext,
} from "./types.js";

export {
  ErrorRegistry,
  globalRegistry,
  mapError,
  toPublicError,
  serializePublicError,
  generateRequestId,
} from "./registry.js";

export {
  HubError,
  MessageTooLargeError,
  ConnectionLimitError,
  ConnectionClosedError,
  UnauthenticatedError,
  ForbiddenError,
  ValidationFailedError,
  VersionUnsupportedError,
  RateLimitedError,
  RoomFullError,
  OverloadedError,
  RoomNotFoundError,
  NamespaceNotFoundError,
  DocumentNotFoundError,
  EventTimeoutError,
  DeliveryFailedError,
  RetryExhaustedError,
  DocumentForbiddenError,
  CrdtInvalidOperationError,
  TenantIsolationError,
  RoomCapacityError,
  DocumentError,
  RoomError,
  CleanupError,
  AuthenticationTimeoutError,
  ConnectionNotAuthenticatedError,
  UwsModuleNotFoundError,
  UwsUnsupportedRuntimeError,
  UwsListenFailedError,
  HandshakeUnauthorizedError,
  HandshakeOriginRejectedError,
  HandshakeTimeoutError,
  SendBackpressuredError,
  RealtimeAlreadyStartedError,
  RealtimeStartCancelledError,
  HostIntegrationInvalidError,
  PublicUrlRequiredError,
} from "./hub-error.js";

export {
  withDeadline,
  DeadlineExceededError,
  type DeadlineOptions,
} from "./deadline.js";

export {
  withRetry,
  isRetryableError,
  retryAfterMsOf,
  computeBackoffMs,
  type RetryOptions,
} from "./retry.js";

export {
  CircuitBreaker,
  CircuitBreakerError,
  type CircuitState,
  type CircuitBreakerOptions,
  type CircuitBreakerSnapshot,
} from "./circuit-breaker.js";
