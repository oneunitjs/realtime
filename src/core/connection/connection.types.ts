/**
 * Core Hub connection types.
 *
 * Transport-independent contracts shared by the Hub, transports, and tests.
 * The Core Hub never imports a concrete WebSocket library; it only ever sees a
 * {@link TransportConnection}.
 */

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

/**
 * Canonical connection lifecycle.
 *
 * CONNECTING -> AUTHENTICATING -> AUTHENTICATED -> CLOSING -> CLOSED
 *
 * Room membership and document subscriptions are separate resources and are
 * never modelled as connection states.
 */
export type ConnectionState =
  | "connecting"
  | "authenticating"
  | "authenticated"
  | "closing"
  | "closed";

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

/**
 * Trusted identity derived only from a verified credential. Never accepted
 * from unverified client message payloads.
 *
 * Canonical principal / authenticated principal type shared by the whole
 * codebase. `roles` and `sessionId` are optional so the minimal principal
 * shape (userId + tenantId) used by presence and room namespaces is a
 * structural subtype.
 */
export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly tenantId: string;
  readonly roles?: readonly string[];
  readonly sessionId?: string;
}

/** Alias kept for the Core Hub vocabulary. */
export type Principal = AuthenticatedPrincipal;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * A single inbound message received from the transport.
 */
export interface TransportMessage {
  readonly data: Uint8Array;
  readonly isBinary: boolean;
}

/**
 * Options for sending a message over the transport.
 */
export interface SendOptions {
  readonly compress?: boolean;
}

/**
 * Result of a send operation. Local acceptance is not peer delivery.
 */
export type SendResult =
  | { status: "accepted"; bufferedBytes: number }
  | { status: "backpressured"; bufferedBytes: number };

/**
 * Close event emitted when a transport connection closes.
 */
export interface TransportCloseEvent {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

/**
 * Unsubscribe function returned by event subscriptions.
 */
export type Unsubscribe = () => void;

/**
 * Handshake metadata observed at WebSocket upgrade. Shared by the transport
 * adapter, Hub auth, and the public `createRealtime` facade.
 */
export interface HandshakeContext {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly origin?: string;
  readonly remoteAddress?: string;
  readonly query: Readonly<Record<string, string>>;
  readonly protocol?: string;
  readonly signal: AbortSignal;
}

/**
 * Normalised transport contract. The Hub only ever talks to this interface,
 * which keeps the core logic testable without real WebSockets.
 *
 * The transport adapter owns the socket and library quirks; the Hub owns
 * application connection state, auth, rooms, and cleanup orchestration.
 */
export interface TransportConnection {
  readonly id: string;
  readonly remoteAddress?: string;
  readonly state: "open" | "closing" | "closed";

  /**
   * Enqueue bytes to the local socket. Resolves on local buffer accept,
   * not peer receipt.
   */
  send(data: Uint8Array, options?: SendOptions): Promise<SendResult>;

  close(code?: number, reason?: string): Promise<void>;

  /** Bytes still buffered in the local transport send path. */
  bufferedBytes(): number;

  onMessage(handler: (message: TransportMessage) => void): Unsubscribe;

  onClose(handler: (event: TransportCloseEvent) => void): Unsubscribe;

  onDrain(handler: () => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Client connection
// ---------------------------------------------------------------------------

export interface ClientConnection {
  id: string;
  state: ConnectionState;
  principal?: Principal;
  transport: TransportConnection;
  connectedAt: number;
  lastSeenAt: number;
  abort: AbortController;
}

// ---------------------------------------------------------------------------
// Room membership
// ---------------------------------------------------------------------------

/** Composite membership identity: connectionId:roomId. */
export type MembershipKey = `${string}:${string}`;

export interface RoomMembership {
  connectionId: string;
  roomId: string;
  tenantId: string;
  joinedAt: number;
}

// ---------------------------------------------------------------------------
// Document subscriptions
// ---------------------------------------------------------------------------

export interface DocumentSubscription {
  connectionId: string;
  documentId: string;
  tenantId: string;
  permissions: readonly ("read" | "write")[];
  subscribedAt: number;
}

// ---------------------------------------------------------------------------
// Publish result
// ---------------------------------------------------------------------------

export type PublishResult =
  | { status: "delivered"; recipientCount: number }
  | { status: "partial"; delivered: number; failed: number }
  | { status: "rejected"; reason: string };

// ---------------------------------------------------------------------------
// Client event
// ---------------------------------------------------------------------------

export interface ClientEvent {
  type: string;
  /** Target room id for a room-scoped event. */
  roomId?: string;
  /** Target document id for a document-scoped event. */
  documentId?: string;
  /** Explicit recipient connection ids. */
  recipientIds?: string[];
  /** Exclude the sender from fan-out. Defaults to true for rooms, false for documents. */
  excludeSender?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface HubConfig {
  maxConnections: number;
  maxFrameBytes: number;
  maxRoomsPerConnection: number;
  maxDocumentsPerConnection: number;
  maxQueuedBytesPerConnection: number;
  authTimeoutMs: number;
  pingIntervalMs: number;
  pongTimeoutMs: number;
  publishRateLimit: { maxRequests: number; windowMs: number };
}

export const DEFAULT_HUB_CONFIG: Readonly<HubConfig> = Object.freeze({
  maxConnections: 10_000,
  maxFrameBytes: 256 * 1024,
  maxRoomsPerConnection: 100,
  maxDocumentsPerConnection: 100,
  maxQueuedBytesPerConnection: 256 * 1024,
  authTimeoutMs: 7_500,
  pingIntervalMs: 25_000,
  pongTimeoutMs: 75_000,
  publishRateLimit: { maxRequests: 100, windowMs: 60_000 },
});
