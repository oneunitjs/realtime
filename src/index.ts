export { Hub, createHub, type HubOptions, type HubMetrics } from "./core/core-hub.js";
export type { AuthProvider, AuthContext } from "./core/auth/auth-provider.js";
export { anonymousAuthProvider, credentialFromHandshake } from "./core/auth/auth-provider.js";

export type {
  ClientConnection,
  ConnectionState,
  Principal,
  AuthenticatedPrincipal,
  HandshakeContext,
  TransportConnection,
  TransportCloseEvent,
  PublishResult,
  HubConfig,
  ClientEvent,
  TransportMessage,
  SendResult,
  SendOptions,
  Unsubscribe,
} from "./core/connection/connection.types.js";

export {
  UwsTransportAdapter,
  createUwsTransport,
  createRealtimeTransport,
  type UwsTransportAdapterOptions,
  type RealtimeTransport,
} from "./transport/index.js";

export {
  attachHubToServer,
  createHubListener,
  type AttachOptions,
} from "./transport/attach.js";

export {
  expressRealtime,
  fastifyRealtime,
  koaRealtime,
  nodeHttpRealtime,
} from "./host/host-server-adapter.js";
export type {
  HostServerAdapter,
  ExpressRealtimeOptions,
  FastifyRealtimeOptions,
} from "./host/host-server-adapter.js";

export {
  HubError,
  ErrorRegistry,
  mapError,
  toPublicError,
  serializePublicError,
  generateRequestId,
  withDeadline,
  DeadlineExceededError,
  withRetry,
  isRetryableError,
  retryAfterMsOf,
  CircuitBreaker,
  CircuitBreakerError,
  SilentLogger,
  ConsoleLogger,
} from "./error/index.js";

export type {
  ErrorCode,
  PublicError,
  ErrorRegistryEntry,
  ErrorRegistryMapping,
  CorrelationContext,
  Logger,
} from "./error/index.js";

export {
  EnvelopeService,
  generateDeviceKeys,
  MemoryDeviceIdentityManager,
  MemoryKeyDirectory,
  ReplayGuard,
  E2EE_PROTOCOL_VERSION,
  E2EE_MAX_ENVELOPE_BYTES,
  E2EEError,
  UnsupportedVersionError,
  InvalidEnvelopeError,
  EnvelopeTooLargeError,
  InvalidSignatureError,
  UnknownEpochError,
  RevokedDeviceError,
  AeadFailureError,
  NonceMisuseError,
  ReplayError,
  KeyNotFoundError,
  e2eeReady,
  isE2EEReady,
} from "./e2ee/index.js";

export type {
  EncryptedEnvelope,
  DeviceIdentity,
  SignedDeviceRecord,
  TrustState,
  TrustResult,
  DeviceIdentityManager,
  KeyDirectory,
  E2EEErrorCode,
} from "./e2ee/index.js";

export {
  EventService,
  type EventServiceDeps,
} from "./event/index.js";

export {
  PROTOCOL_VERSION,
  type RealtimeEnvelope,
  type Codec,
  type CodecName,
  encodeFrame,
  decodeFrame,
  jsonCodec,
  messagepackCodec,
} from "./protocol/index.js";

export {
  createRealtime,
  type RealtimeServer,
  type RealtimeAddress,
  type RealtimeShutdownResult,
  type RealtimeHealth,
  type RealtimeState,
  type RealtimeMode,
  type RealtimeConfig,
  type RealtimeTransportConfig,
  type RealtimeAuthConfig,
  type RealtimeLimitsConfig,
} from "./public/create-realtime.js";
