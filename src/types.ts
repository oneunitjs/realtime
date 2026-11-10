/**
 * Shared type definitions for @oneunit/realtime.
 *
 * Every public type lives here so consumers can import isolated type surface
 * without loading runtime code, and internal modules share one canonical
 * definition of every shape.
 */

import type { TransportConnection, Unsubscribe } from "./core/connection/connection.types.js";
import type { Logger } from "./error/index.js";

// ---------------------------------------------------------------------------
// Connection & client
// ---------------------------------------------------------------------------

/**
 * Canonical connection contract. `Connection` is an alias for the normalised
 * `TransportConnection` so there is a single connection contract across the
 * package (docs/architecture-consolidation-uws-plan-v2.md §5.1).
 */
export type Connection = TransportConnection;

/** Connection lifecycle states owned by the hub. */
export type ConnectionLifecycle =
  | "connecting"
  | "authenticating"
  | "authenticated"
  | "active"
  | "closing"
  | "closed";

/** Mutable lifecycle state owned by the hub for one connection. */
export interface ConnectionLifecycleState {
  readonly connectionId: string;
  status: ConnectionLifecycle;
  reason?: string;
}

/** Immutable view of a tracked client. */
export interface Client {
  readonly id: string;
  readonly connection: Connection;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly joinedAt: number;
  readonly lastSeenAt: number;
  readonly channels: ReadonlySet<string>;
  readonly lifecycle: ConnectionLifecycleState;
}

export interface ClientInput {
  id?: string;
  connection: Connection;
  metadata?: Record<string, unknown>;
}

export interface JoinOptions {
  id?: string;
  metadata?: Record<string, unknown>;
}

/** Anything carrying a client id. */
export interface ClientRef {
  id: string;
}

// ---------------------------------------------------------------------------
// Broadcast & delivery
// ---------------------------------------------------------------------------

/** Anything that can deliver an already decoded message to a channel. */
export interface BroadcastTarget {
  broadcast(
    channelName: string,
    message: unknown,
    options?: BroadcastOptions,
  ): Promise<number> | number;
}

export interface BroadcastOptions {
  /** Client ids to skip. */
  exclude?: Iterable<string>;
  /** Send only to these client ids. */
  include?: Iterable<string>;
  /** Recorded on the `broadcast` event. Never forwarded to clients. */
  metadata?: Record<string, unknown>;
  /** Also authorize every recipient for `send`. */
  authorizeRecipients?: boolean;
}

// ---------------------------------------------------------------------------
// Channel abstraction
// ---------------------------------------------------------------------------

/** Result of a channel broadcast or send operation. */
export interface DeliveryResult {
  /** Number of recipients the frame was written to. */
  delivered: number;
  /** Number of recipients that failed to receive the frame. */
  failed: number;
}

/** Handler for incoming channel messages. */
export type MessageHandler<TMessage = unknown> = (
  message: TMessage,
  context: { clientId: string; channel: string },
) => void | Promise<void>;

/** Subscription to channel lifecycle events. */
export type ChannelEventName =
  | "join"
  | "leave"
  | "message"
  | "error";

/**
 * First-class reference to a channel. A channel is a stable identity for
 * membership and message distribution; obtaining a channel does not imply
 * the caller is joined to it.
 */
export interface Channel<TMessage = unknown> {
  readonly name: string;

  /** Broadcast a message to every member of the channel. */
  broadcast(
    message: TMessage,
    options?: BroadcastOptions,
  ): Promise<DeliveryResult>;

  /** Send a message to a specific member of the channel. */
  sendTo(clientId: string, message: TMessage): Promise<void>;

  /** Number of members currently in the channel. */
  memberCount(): number;

  /** Subscribe to incoming messages on this channel. */
  on(event: "message", handler: MessageHandler<TMessage>): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export type { Logger };

// ---------------------------------------------------------------------------
// Limits & configuration
// ---------------------------------------------------------------------------

export interface RealtimeLimits {
  maxConnections: number;
  maxClientsPerChannel: number;
  maxChannelsPerClient: number;
  maxMessageSize: number;
  maxChannelNameLength: number;
  /** Maximum milliseconds to wait for in-flight delivery to drain on shutdown. */
  shutdownTimeoutMs: number;
}

/** Result of a graceful hub shutdown. */
export interface ShutdownResult {
  /** Whether all connections were drained before the timeout. */
  drained: boolean;
  /** Number of connections that had their send queues drained. */
  drainedConnections: number;
  /** Number of connections still connected when the timeout expired. */
  remainingConnections: number;
}

export interface HeartbeatOptions {
  intervalMs: number;
  timeoutMs: number;
}

export interface BackpressureOptions {
  maxBufferedBytes: number;
  maxConsecutiveDrops: number;
  maxQueuedBytes: number;
  maxQueuedMessages: number;
}

// ---------------------------------------------------------------------------
// Actions & hooks
// ---------------------------------------------------------------------------

export type RealtimeAction = "connect" | "join" | "leave" | "send" | "broadcast";

export interface AuthenticateContext {
  connection: Connection;
  request?: unknown;
}

export type AuthenticateHook = (
  context: AuthenticateContext,
) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>;

export interface AuthorizeContext {
  action: RealtimeAction;
  channel?: string;
  client?: Client;
  metadata?: Readonly<Record<string, unknown>>;
}

export type AuthorizeHook = (
  context: AuthorizeContext,
) => boolean | void | Promise<boolean | void>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type RealtimeEventName =
  | "connect"
  | "disconnect"
  | "join"
  | "leave"
  | "send"
  | "drop"
  | "broadcast"
  | "reject";

export interface RealtimeEvent {
  name: RealtimeEventName;
  clientId?: string;
  channel?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  at: number;
}
