/**
 * Core Hub — transport-independent real-time connection runtime.
 *
 * Implements the architecture in docs/core/core-hub.md and
 * docs/core/core-hub-architecture-plan.md:
 *
 * - Canonical lifecycle: connecting -> authenticating -> authenticated ->
 *   closing -> closed
 * - Trusted Principal created only by the AuthProvider after verification
 * - Room membership (capacity, idempotent, race-safe via per-room queue)
 * - Document subscriptions (distinct from room membership)
 * - Presence derived from live connection leases
 * - Heartbeat-based expiry
 * - Idempotent, single-flight disconnect + cleanup
 * - Typed PublishResult for routing/delivery
 * - Middleware around inbound actions
 *
 * The Hub never imports a concrete WebSocket library; it only ever sees a
 * {@link TransportConnection}.
 */

import type {
  ClientConnection,
  ClientEvent,
  ConnectionState,
  HubConfig,
  Principal,
  PublishResult,
  TransportCloseEvent,
  TransportConnection,
} from "./connection/connection.types.js";
import { DEFAULT_HUB_CONFIG } from "./connection/connection.types.js";
import { ConnectionRegistry } from "./connection/connection-registry.js";
import { RoomAdapter } from "./rooms/room-adapter.js";
import { DocumentAdapter } from "./documents/document-adapter.js";
import { PresenceAdapter } from "./presence/presence-adapter.js";
import { DisconnectCoordinator } from "./cleanup/disconnect-coordinator.js";
import { MiddlewareRunner, type Middleware } from "./middleware/middleware-runner.js";
import { FanoutScheduler } from "../event/fanout.js";
import { Router } from "./routing/router.js";
import type { Clock } from "./infrastructure/clock.js";
import { SystemClock } from "./infrastructure/clock.js";
import type { IdGenerator } from "./infrastructure/id-generator.js";
import { UuidIdGenerator } from "./infrastructure/id-generator.js";
import type { Logger } from "../error/index.js";
import { SilentLogger } from "../error/logger.js";
import type { Metrics } from "./infrastructure/metrics.js";
import { SilentMetrics } from "./infrastructure/metrics.js";
import type { AuthProvider } from "./auth/auth-provider.js";
import { anonymousAuthProvider, credentialFromHandshake } from "./auth/auth-provider.js";
import type { HandshakeContext } from "./connection/connection.types.js";
import { decodeFrame, encodeFrame, type CodecName } from "../protocol/index.js";
import { encodeRoomKey } from "../room-namespace/room-key.js";
import { ValidationFailedError } from "../error/index.js";
import type { EncryptedEnvelope } from "../e2ee/types.js";
import type { EnvelopeService } from "../e2ee/envelope.js";
import type { ErrorRegistry, PublicError } from "../error/index.js";
import { globalRegistry, mapError } from "../error/index.js";
import {
  AuthenticationTimeoutError,
  CleanupError,
  ConnectionNotAuthenticatedError,
  ForbiddenError,
  TenantIsolationError,
} from "../error/index.js";
import "../error/registry.js";

export interface HubOptions {
  authProvider?: AuthProvider | undefined;
  config?: Partial<HubConfig>;
  clock?: Clock;
  idGenerator?: IdGenerator;
  logger?: Logger;
  metrics?: Metrics;
  /** Per-room capacity limits, keyed by room id. */
  roomCapacities?: Record<string, number>;
  /** Envelope service for routing opaque E2EE envelopes without decrypting. */
  envelopeService?: EnvelopeService;
  /** Shared error registry for mapping internal failures to public codes. */
  errorRegistry?: ErrorRegistry;
  /** Authorize a protected action for an authenticated principal. */
  authorize?: (
    action: "room:join" | "room:leave" | "document:read" | "document:write" | "event:publish",
    principal: Principal,
    resourceId?: string,
    tenantId?: string
  ) => Promise<boolean> | boolean;
  /** Notify when a connection joins a room (after membership commit). */
  onRoomJoin?: (connectionId: string, roomId: string) => void | Promise<void>;
  /** Notify when a connection leaves a room. */
  onRoomLeave?: (connectionId: string, roomId: string) => void | Promise<void>;
  /** Notify when a connection subscribes to a document. */
  onDocumentSubscribe?: (
    connectionId: string,
    documentId: string
  ) => void | Promise<void>;
  /** Notify when a connection unsubscribes from a document. */
  onDocumentUnsubscribe?: (
    connectionId: string,
    documentId: string
  ) => void | Promise<void>;
}

export interface HubMetrics {
  connections: number;
  authenticated: number;
  authenticating: number;
  connecting: number;
  closing: number;
  closed: number;
  rooms: number;
  documents: number;
  memberships: number;
  subscriptions: number;
}

/**
 * @deprecated Legacy reference retained for compatibility; use {@link Hub} instead of the old RealtimeHub.
 * backward compatibility but will be removed in a future major release.
 *
 * @see {@link RealtimeHub} for the canonical runtime API.
 */
export class Hub {
  private readonly config: Readonly<HubConfig>;
  private readonly authProvider: AuthProvider;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly authorize: HubOptions["authorize"];

  private readonly registry: ConnectionRegistry;
  private readonly membership: RoomAdapter;
  private readonly documentStore: DocumentAdapter;
  private readonly presence: PresenceAdapter;
  private readonly coordinator: DisconnectCoordinator;
  private readonly middleware: MiddlewareRunner;
  private readonly fanout: FanoutScheduler;
  private readonly router: Router;

  private readonly roomCapacities: Map<string, number>;
  private readonly envelopeService?: EnvelopeService;
  private readonly errorRegistry: ErrorRegistry;
  private readonly onRoomJoin?: HubOptions["onRoomJoin"];
  private readonly onRoomLeave?: HubOptions["onRoomLeave"];
  private readonly onDocumentSubscribe?: HubOptions["onDocumentSubscribe"];
  private readonly onDocumentUnsubscribe?: HubOptions["onDocumentUnsubscribe"];

  private closed = false;
  private readonly codecs = new Map<string, CodecName>();

  private readonly heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: HubOptions) {
    this.config = Object.freeze({
      ...DEFAULT_HUB_CONFIG,
      ...options.config,
    }) as Readonly<HubConfig>;

    this.authProvider = options.authProvider ?? anonymousAuthProvider;
    this.clock = options.clock ?? new SystemClock();
    this.idGenerator = options.idGenerator ?? new UuidIdGenerator();
    this.logger = options.logger ?? new SilentLogger();
    this.metrics = options.metrics ?? new SilentMetrics();
    this.authorize = options.authorize;
    this.onRoomJoin = options.onRoomJoin;
    this.onRoomLeave = options.onRoomLeave;
    this.onDocumentSubscribe = options.onDocumentSubscribe;
    this.onDocumentUnsubscribe = options.onDocumentUnsubscribe;
    this.roomCapacities = new Map(Object.entries(options.roomCapacities ?? {}));
    this.envelopeService = options.envelopeService;
    this.errorRegistry = options.errorRegistry ?? globalRegistry;

    this.heartbeatTimer = setInterval(() => this.sweepHeartbeat(), this.config.pingIntervalMs);
    this.heartbeatTimer.unref?.();

    this.registry = new ConnectionRegistry(this.clock, this.idGenerator);
    this.membership = new RoomAdapter(Object.fromEntries(this.roomCapacities));
    this.documentStore = new DocumentAdapter();
    this.presence = new PresenceAdapter();
    this.coordinator = new DisconnectCoordinator();
    this.middleware = new MiddlewareRunner();
    this.fanout = new FanoutScheduler({
      maxQueuedBytesPerConnection: this.config.maxQueuedBytesPerConnection,
    });
    this.router = new Router(
      this.fanout,
      this.logger,
      this.metrics,
      (roomId) => this.resolveRoomMembers(roomId),
      (documentId) => this.resolveDocumentSubscribers(documentId)
    );
  }

  use(middleware: Middleware): void {
    this.middleware.use(middleware);
  }

  // ------------------------------------------------------------------ public API

  /**
   * Accept a new transport and start authentication. The returned connection
   * is `authenticating` until the credential is verified, then `authenticated`.
   * On failure, timeout, or disconnect during authentication the provisional
   * record is removed exactly once and the transport is closed.
   */
  async connect(
    transport: TransportConnection,
    credential?: string,
    handshake?: HandshakeContext,
  ): Promise<ClientConnection> {
    if (this.closed) {
      throw new Error("Hub is closed");
    }

    const entry = this.registry.register(transport);
    const { id, abort } = entry;

    this.registry.setState(id, "authenticating");

    const onClose = (event: TransportCloseEvent) => {
      void this.disconnect(id, event.reason);
    };

    transport.onClose(onClose);

    const abortListener = () => {
      void this.disconnect(id, "aborted");
    };
    abort.signal.addEventListener("abort", abortListener, { once: true });

    transport.onMessage((message) => {
      void this.handleInbound(id, message.data);
    });

    try {
      const resolvedCredential = credential ?? credentialFromHandshake(handshake);
      const principal = await this.authenticateWithDeadline(
        resolvedCredential,
        abort.signal,
        handshake,
      );

      if (abort.signal.aborted || this.registry.get(id)?.state === "closing") {
        throw new ConnectionNotAuthenticatedError(id);
      }

      this.registry.setPrincipal(id, principal);
      this.registry.setState(id, "authenticated");
      await this.presence.set(id, principal, this.clock.now());

      this.metrics.increment("hub.connections");
      this.metrics.increment("hub.authenticated");
      this.logger.info?.(
        { connectionId: id, userId: principal.userId, tenantId: principal.tenantId },
        "Connection authenticated"
      );

      abort.signal.removeEventListener("abort", abortListener);

      if (handshake) {
        await this.sendFrame(transport, {
          type: "welcome",
          payload: {
            connectionId: id,
            userId: principal.userId,
            tenantId: principal.tenantId,
          },
        }, id);
      }

      return entry;
    } catch (error) {
      abort.signal.removeEventListener("abort", abortListener);

      await this.doDisconnect(id, error instanceof Error ? error.message : undefined, true);
      throw error;
    }
  }

  /** Idempotent teardown. Safe to call from many places concurrently. */
  async disconnect(connectionId: string, reason?: string): Promise<void> {
    const report = await this.coordinator.disconnect(connectionId, reason, [
      () => this.stepClose(connectionId),
      () => this.stepRemoveMemberships(connectionId),
      () => this.stepRemoveDocumentSubscriptions(connectionId),
      () => this.stepReleasePresence(connectionId),
      () => this.stepSettleDelivery(connectionId),
      () => this.stepCloseTransport(connectionId),
      () => this.stepMarkClosed(connectionId),
    ]);

    if (report.steps.some((step) => !step.ok)) {
      this.logger.warn?.(
        { connectionId, reason, errors: report.steps.filter((s) => !s.ok) },
        "Disconnect completed with cleanup errors"
      );
    }

    if (report.steps.some((s) => !s.ok)) {
      throw new CleanupError(`Cleanup had errors for connection ${connectionId}`, report.steps.map((s) => s.error).filter(Boolean));
    }
  }

  /** Join a room after authentication. Idempotent. */
  async joinRoom(connectionId: string, roomId: string): Promise<void> {
    const entry = this.requireAuthenticated(connectionId);
    const principal = entry.principal!;

    await this.middleware.run(
      { action: "room:join", connectionId, payload: { roomId } },
      async () => {
        const authorized = await this.authorizeAction(
          "room:join",
          principal,
          roomId,
          principal.tenantId
        );
        if (!authorized) {
          throw new ForbiddenError("room:join");
        }

        const { added, membership } = await this.membership.join(
          connectionId,
          principal,
          principal.tenantId,
          roomId
        );

        if (!added) {
          // Already a member; idempotent.
          return;
        }

        // Recheck connection state after the async boundary. If the
        // connection disconnected while the join was awaiting, rollback
        // the membership to avoid stale state.
        try {
          this.requireAuthenticated(connectionId);
        } catch (error) {
          try {
            await this.membership.leave(connectionId, roomId);
          } catch {
            // Best-effort rollback; disconnect cleanup will also remove it.
          }
          throw error;
        }

        this.presence.addRoom(connectionId, roomId);
        this.metrics.increment("hub.room.join");
        this.logger.info?.(
          { connectionId, roomId, tenantId: principal.tenantId, userId: principal.userId },
          "Joined room"
        );

        if (this.authorize && typeof this.authorize === "function") {
          // presence update already committed; notify after commit.
        }

        void this.notifyRoomJoin(connectionId, roomId);
      }
    );
  }

  /** Leave a room. Idempotent and safe to call multiple times. */
  async leaveRoom(connectionId: string, roomId: string): Promise<void> {
    const entry = this.requireAuthenticated(connectionId);
    const principal = entry.principal!;

    await this.middleware.run(
      { action: "room:leave", connectionId, payload: { roomId } },
      async () => {
        const authorized = await this.authorizeAction(
          "room:leave",
          principal,
          roomId,
          principal.tenantId
        );
        if (!authorized) {
          throw new ForbiddenError("room:leave");
        }

        const removed = await this.membership.leave(connectionId, roomId);
        if (!removed) {
          return; // idempotent: not a member
        }

        this.requireAuthenticated(connectionId);
        this.presence.removeRoom(connectionId, roomId);
        this.metrics.increment("hub.room.leave");
        void this.notifyRoomLeave(connectionId, roomId);
      }
    );
  }

  /** Subscribe to a document after authentication. */
  async subscribeDocument(
    connectionId: string,
    documentId: string,
    permission: "read" | "write" = "read"
  ): Promise<void> {
    const entry = this.requireAuthenticated(connectionId);
    const principal = entry.principal!;

    await this.middleware.run(
      { action: "document:subscribe", connectionId, payload: { documentId } },
      async () => {
        const authorized = await this.authorizeAction(
          permission === "write" ? "document:write" : "document:read",
          principal,
          documentId,
          principal.tenantId
        );
        if (!authorized) {
          throw new ForbiddenError(
            permission === "write" ? "document:write" : "document:read"
          );
        }

        await this.documentStore.subscribe(
          connectionId,
          principal,
          documentId,
          principal.tenantId,
          permission
        );

        this.requireAuthenticated(connectionId);
        this.presence.addDocument(connectionId, documentId);
        this.metrics.increment("hub.document.subscribe");
        void this.notifyDocumentSubscribe(connectionId, documentId);
      }
    );
  }

  /** Unsubscribe from a document. Idempotent. */
  async unsubscribeDocument(connectionId: string, documentId: string): Promise<void> {
    const entry = this.requireAuthenticated(connectionId);

    await this.middleware.run(
      { action: "document:unsubscribe", connectionId, payload: { documentId } },
      async () => {
        this.documentStore.unsubscribe(connectionId, documentId);
        this.presence.removeDocument(connectionId, documentId);
        this.metrics.increment("hub.document.unsubscribe");
        void this.notifyDocumentUnsubscribe(connectionId, documentId);
      }
    );
  }

  /**
   * Route a client-originated event to the correct recipients. Returns a
   * typed PublishResult, never a bare boolean.
   */
  async publish(
    connectionId: string,
    event: ClientEvent
  ): Promise<PublishResult> {
    const entry = this.requireAuthenticated(connectionId);
    const principal = entry.principal!;

    const data = this.encodeEvent(event);

    let delivered = 0;
    let failed = 0;

    try {
      await this.middleware.run(
        { action: "event:publish", connectionId, payload: event },
        async () => {
          const authorized = await this.authorizeAction(
            "event:publish",
            principal,
            event.roomId ?? event.documentId,
            principal.tenantId
          );
          if (!authorized) {
            this.metrics.increment("hub.publish.rejected");
            throw new ForbiddenError("event:publish");
          }

          if (event.roomId) {
            // Enforce room membership: a client may only publish to rooms it joined.
            const namespaceId = DEFAULT_NAMESPACE;
            const roomKey = encodeRoomKey(principal.tenantId, namespaceId, event.roomId);
            const roomMembers = this.membership.membersByRoomKey(roomKey);
            if (!roomMembers.includes(connectionId)) {
              this.metrics.increment("hub.publish.rejected");
              throw new ForbiddenError(
                `Not a member of room ${event.roomId}`,
              );
            }
            const result = await this.router.publishToRoom(
              roomKey,
              data,
              connectionId,
              event.excludeSender ?? true
            );
            delivered += result.delivered;
            failed += result.failed;
          } else if (event.documentId) {
            const result = await this.router.publishToDocument(
              event.documentId,
              data,
              connectionId,
              event.excludeSender ?? false
            );
            delivered += result.delivered;
            failed += result.failed;
          } else if (event.recipientIds?.length) {
            for (const recipientId of event.recipientIds) {
              const recipient = this.registry.get(recipientId);
              if (
                recipient &&
                recipient.state === "authenticated" &&
                recipient.transport
              ) {
                const ok = await this.fanout.enqueue(
                  {
                    connectionId: recipient.transport.id,
                    send: (d: Uint8Array) => recipient.transport.send(d).then(() => {}),
                  },
                  data
                );
                if (ok) {
                  delivered += 1;
                } else {
                  failed += 1;
                }
              } else {
                failed += 1;
              }
            }
          }

          this.metrics.increment("hub.publish");
        }
      );
    } catch (error) {
      if (error instanceof ForbiddenError) {
        return { status: "rejected", reason: error.message };
      }
      throw error;
    }

    if (failed > 0 && delivered > 0) {
      return { status: "partial", delivered, failed };
    }
    if (failed > 0) {
      return { status: "partial", delivered: 0, failed };
    }
    return { status: "delivered", recipientCount: delivered };
  }

  /**
   * Route an opaque E2EE envelope to authorized recipients without
   * decrypting it (docs/e2ee/e2ee-encryption.md §8.1). The Hub validates
   * envelope schema/size, binds the sender identity to the authenticated
   * principal, authorizes publication, and forwards the ciphertext bytes
   * only to members of the conversation. Plaintext is never seen here.
   */
  async sendEnvelope(
    connectionId: string,
    envelope: EncryptedEnvelope,
  ): Promise<{ delivered: number; failed: number }> {
    const entry = this.requireAuthenticated(connectionId);
    const principal = entry.principal!;

    if (!this.envelopeService) {
      const err = new Error("E2EE is not enabled on this hub");
      (err as any).code = "E2EE_NOT_ENABLED";
      throw err;
    }

    // Validate envelope schema, size, and version (fail closed). No
    // decryption happens here.
    this.envelopeService.validateEnvelope(envelope);

    // Bind the envelope sender identity to the authenticated principal.
    if (envelope.senderUserId !== principal.userId) {
      throw new TenantIsolationError(
        "Envelope sender userId does not match authenticated identity",
      );
    }

    // Authorize the sender to publish to this conversation/room.
    const authorized = await this.authorizeAction(
      "event:publish",
      principal,
      envelope.conversationId,
      principal.tenantId,
    );
    if (!authorized) {
      throw new ForbiddenError("event:publish");
    }

    const encoded = this.envelopeService.encodeEnvelope(envelope);
    const namespaceId = DEFAULT_NAMESPACE;
    const roomKey = encodeRoomKey(principal.tenantId, namespaceId, envelope.conversationId);
    const memberIds = this.membership.membersByRoomKey(roomKey);

    let delivered = 0;
    let failed = 0;
    for (const memberId of memberIds) {
      const recipient = this.registry.get(memberId);
      if (!recipient || recipient.state !== "authenticated" || !recipient.transport) {
        continue;
      }
      if (memberId === connectionId) {
        continue; // sender already holds the plaintext
      }
      const ok = await this.fanout.enqueue(
        {
          connectionId: recipient.transport.id,
          send: (d: Uint8Array) => recipient.transport.send(d).then(() => {}),
        },
        encoded
      );
      if (ok) {
        delivered += 1;
      } else {
        failed += 1;
      }
    }

    this.metrics.increment("hub.publish");
    return { delivered, failed };
  }

  /** Inspection helper (mainly for tests / admin). */
  getConnection(connectionId: string): ClientConnection | undefined {
    return this.registry.get(connectionId);
  }

  /**
   * Map an internal error through the shared error registry to the safe
   * public contract (docs/error/error-handling.md §7). Clients receive only
   * the `PublicError` allowlist; internal details are never leaked.
   */
  toPublicError(
    error: unknown,
    options?: { requestId?: string },
  ): PublicError {
    return mapError(error, {
      requestId: options?.requestId,
      registry: this.errorRegistry,
    });
  }

  memberCount(roomId: string): number {
    return this.membership.count(roomId);
  }

  roomMembers(roomId: string): string[] {
    return this.membership.members(roomId);
  }

  get closedForShutdown(): boolean {
    return this.closed;
  }

  get metricsSnapshot(): HubMetrics {
    return {
      connections: this.registry.size(),
      authenticated: this.countByState("authenticated"),
      authenticating: this.countByState("authenticating"),
      connecting: this.countByState("connecting"),
      closing: this.countByState("closing"),
      closed: this.countByState("closed"),
      rooms: this.membership.roomCount(),
      documents: this.documentStore.documentCount(),
      memberships: this.membership.total(),
      subscriptions: this.documentStore.total(),
    };
  }

  /** Graceful shutdown: close every connection and stop the heartbeat. Awaits
   *  all connection disconnects before resolving. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    const connections = this.registry.all();
    await Promise.allSettled(
      connections.map((connection) =>
        this.disconnect(connection.id, "server shutdown"),
      ),
    );
  }

  // ---------------------------------------------------------------- private

  private async handleInbound(connectionId: string, data: Uint8Array): Promise<void> {
    const entry = this.registry.get(connectionId);
    if (!entry || entry.state === "closing" || entry.state === "closed") {
      return;
    }

    this.registry.touch(connectionId);

    let envelope: { type: string; channel?: string; payload?: unknown; error?: unknown };
    try {
      const codec = detectCodec(data);
      this.codecs.set(connectionId, codec);
      const decoded = decodeFrame(data, { codec });
      envelope = decoded.envelope;
    } catch {
      return;
    }

    if (entry.state !== "authenticated") {
      return;
    }

    const roomId = channelOf(envelope);
    try {
      switch (envelope.type) {
        case "join":
          if (!roomId) {
            throw new ValidationFailedError("join requires channel");
          }
          await this.joinRoom(connectionId, roomId);
          await this.sendFrame(entry.transport, { type: "joined", channel: roomId }, connectionId);
          break;
        case "leave":
          if (!roomId) {
            throw new ValidationFailedError("leave requires channel");
          }
          await this.leaveRoom(connectionId, roomId);
          await this.sendFrame(entry.transport, { type: "left", channel: roomId }, connectionId);
          break;
        case "message":
        case "publish":
          if (!roomId) {
            throw new ValidationFailedError("message requires channel");
          }
          await this.publish(connectionId, {
            type: "message",
            roomId,
            payload: envelope.payload,
          });
          break;
        case "subscribe": {
          const documentId = documentIdOf(envelope);
          if (!documentId) {
            throw new ValidationFailedError("subscribe requires documentId");
          }
          await this.subscribeDocument(connectionId, documentId);
          await this.sendFrame(entry.transport, { type: "subscribed", channel: documentId }, connectionId);
          break;
        }
        case "unsubscribe": {
          const documentId = documentIdOf(envelope);
          if (!documentId) {
            throw new ValidationFailedError("unsubscribe requires documentId");
          }
          await this.unsubscribeDocument(connectionId, documentId);
          await this.sendFrame(entry.transport, { type: "unsubscribed", channel: documentId }, connectionId);
          break;
        }
        case "ping":
          await this.sendFrame(entry.transport, { type: "pong" }, connectionId);
          break;
        default:
          break;
      }
    } catch (error) {
      const publicError = this.toPublicError(error);
      await this.sendFrame(
        entry.transport,
        { type: "error", channel: roomId, error: publicError },
        connectionId,
      );
    }
  }

  private async sendFrame(
    transport: TransportConnection,
    envelope: { type: string; channel?: string; payload?: unknown; error?: unknown },
    connectionId?: string,
  ): Promise<void> {
    const codec = (connectionId && this.codecs.get(connectionId)) || "json";
    const bytes = encodeFrame(
      {
        protocolVersion: 1,
        type: envelope.type,
        channel: envelope.channel,
        payload: envelope.payload,
        error: envelope.error as never,
      },
      { codec },
    );
    try {
      await transport.send(bytes);
    } catch (error) {
      this.logger.warn?.({ err: error }, "Failed to send frame");
    }
  }

  private authenticateWithDeadline(
    credential: string | undefined,
    signal: AbortSignal,
    handshake?: HandshakeContext,
  ): Promise<Principal> {
    const { authTimeoutMs } = this.config;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        this.metrics.increment("hub.auth.timeout");
        reject(new AuthenticationTimeoutError());
      }, authTimeoutMs);
      timeoutId.unref?.();
    });

    const abortPromise = new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new ConnectionNotAuthenticatedError("aborted")),
        { once: true }
      );
    });

    return Promise.race([
      this.authProvider.authenticate(credential, { signal, handshake }),
      timeoutPromise,
      abortPromise,
    ]).finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
  }

  private requireAuthenticated(connectionId: string): ClientConnection {
    const entry = this.registry.get(connectionId);
    if (!entry) {
      throw new ConnectionNotAuthenticatedError(connectionId);
    }
    if (entry.state !== "authenticated") {
      throw new ConnectionNotAuthenticatedError(connectionId);
    }
    if (!entry.principal) {
      throw new ConnectionNotAuthenticatedError(connectionId);
    }
    return entry;
  }

  private async authorizeAction(
    action: "room:join" | "room:leave" | "document:read" | "document:write" | "event:publish",
    principal: Principal,
    resourceId: string | undefined,
    tenantId: string | undefined
  ): Promise<boolean> {
    if (!this.authorize) {
      return true;
    }
    const result = await this.authorize(action, principal, resourceId, tenantId);
    return result === true;
  }

  private async roomTenant(roomId: string): Promise<string | undefined> {
    // Tenant is stored on memberships; derive from any member of the room.
    const members = await this.membership.members(roomId);
    if (members.length === 0) {
      return undefined;
    }
    const entry = this.registry.get(members[0]);
    return entry?.principal?.tenantId;
  }

  private roomCapacity(roomId: string): number | undefined {
    return this.roomCapacities.get(roomId);
  }

  private resolveRoomMembers(roomKey: string): TransportConnection[] {
    const memberIds = this.membership.membersByRoomKey(roomKey);
    const recipients: TransportConnection[] = [];
    for (const memberId of memberIds) {
      const entry = this.registry.get(memberId);
      if (entry && entry.state === "authenticated" && entry.transport) {
        recipients.push(entry.transport);
      }
    }
    return recipients;
  }

  private resolveDocumentSubscribers(documentId: string): TransportConnection[] {
    const subscriberIds = this.documentStore.subscribers(documentId);
    const recipients: TransportConnection[] = [];
    for (const subscriberId of subscriberIds) {
      const entry = this.registry.get(subscriberId);
      if (entry && entry.state === "authenticated" && entry.transport) {
        recipients.push(entry.transport);
      }
    }
    return recipients;
  }

  private encodeEvent(event: ClientEvent): Uint8Array {
    return encodeFrame(
      {
        protocolVersion: 1,
        type: event.type || "message",
        channel: event.roomId ?? event.documentId,
        payload: event.payload ?? event,
      },
      { codec: "json" },
    );
  }

  private countByState(state: ConnectionState): number {
    let count = 0;
    for (const entry of this.registry.all()) {
      if (entry.state === state) {
        count += 1;
      }
    }
    return count;
  }

  // ---------------------------------------------------------------- cleanup steps

  private async stepClose(connectionId: string): Promise<void> {
    const entry = this.registry.beginClose(connectionId);
    if (!entry) {
      return; // already closing/closed or unknown
    }
    entry.abort.abort();
  }

  private async stepRemoveMemberships(connectionId: string): Promise<void> {
    const rooms = await this.membership.removeAllForConnection(connectionId);
    for (const roomId of rooms) {
      this.presence.removeRoom(connectionId, roomId);
      void this.notifyRoomLeave(connectionId, roomId);
    }
    this.metrics.increment("hub.cleanup.memberships", rooms.length);
  }

  private async stepRemoveDocumentSubscriptions(connectionId: string): Promise<void> {
    const documents = this.documentStore.removeAllForConnection(connectionId);
    for (const documentId of documents) {
      this.presence.removeDocument(connectionId, documentId);
      void this.notifyDocumentUnsubscribe(connectionId, documentId);
    }
    this.metrics.increment("hub.cleanup.subscriptions", documents.length);
  }

  private async stepReleasePresence(connectionId: string): Promise<void> {
    this.presence.remove(connectionId);
  }

  private async stepSettleDelivery(connectionId: string): Promise<void> {
    // Pending queued writes for this connection are dropped; the transport is
    // closed shortly after. No unbounded buffering is retained.
    const pending = this.fanout.pendingCount(connectionId);
    if (pending > 0) {
      this.metrics.increment("hub.cleanup.pendingDelivery", pending);
    }
  }

  private async stepCloseTransport(connectionId: string): Promise<void> {
    const entry = this.registry.get(connectionId);
    if (!entry) {
      return;
    }
    try {
      await entry.transport.close();
    } catch (error) {
      this.logger.warn?.({ connectionId, err: error }, "Transport close failed");
    }
  }

  private async stepMarkClosed(connectionId: string): Promise<void> {
    this.registry.markClosed(connectionId);
    this.registry.remove(connectionId);
    this.codecs.delete(connectionId);
    this.metrics.increment("hub.connections", -1);
    this.metrics.increment("hub.closed");
  }

  private async expireConnection(connectionId: string): Promise<void> {
    // Heartbeat expiry runs the same idempotent cleanup path once.
    const entry = this.registry.get(connectionId);
    if (!entry || entry.state === "closing" || entry.state === "closed") {
      return;
    }
    await this.disconnect(connectionId, "heartbeat expiry");
  }

  /** Sweep stale connections: expire those past the pong deadline. */
  private sweepHeartbeat(): void {
    const now = this.clock.now();
    const deadline = this.config.pongTimeoutMs;
    for (const connection of this.registry.all()) {
      if (connection.state === "closing" || connection.state === "closed") {
        continue;
      }
      if (now - connection.lastSeenAt > deadline) {
        void this.disconnect(connection.id, "heartbeat expiry");
      }
    }
  }

  private async doDisconnect(
    connectionId: string,
    reason: string | undefined,
    provisional: boolean
  ): Promise<void> {
    // Provisional cleanup (auth failure): run the same steps but tolerate
    // missing state, and do not throw on cleanup errors.
    const steps = [
      () => this.stepClose(connectionId),
      () => this.stepRemoveMemberships(connectionId),
      () => this.stepRemoveDocumentSubscriptions(connectionId),
      () => this.stepReleasePresence(connectionId),
      () => this.stepSettleDelivery(connectionId),
      () => this.stepCloseTransport(connectionId),
      () => this.stepMarkClosed(connectionId),
    ];

    const errors: unknown[] = [];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      this.logger.warn?.(
        { connectionId, reason, provisional, errors },
        "Provisional cleanup had errors"
      );
    }
  }

  private notifyRoomJoin(connectionId: string, roomId: string): void {
    const handler = this.onRoomJoin;
    if (handler) {
      void (async () => {
        try {
          await handler(connectionId, roomId);
        } catch (error) {
          this.logger.warn?.({ connectionId, roomId, err: error }, "onRoomJoin hook failed");
        }
      })();
    }
  }

  private notifyRoomLeave(connectionId: string, roomId: string): void {
    const handler = this.onRoomLeave;
    if (handler) {
      void (async () => {
        try {
          await handler(connectionId, roomId);
        } catch (error) {
          this.logger.warn?.({ connectionId, roomId, err: error }, "onRoomLeave hook failed");
        }
      })();
    }
  }

  private notifyDocumentSubscribe(connectionId: string, documentId: string): void {
    const handler = this.onDocumentSubscribe;
    if (handler) {
      void (async () => {
        try {
          await handler(connectionId, documentId);
        } catch (error) {
          this.logger.warn?.({ connectionId, documentId, err: error }, "onDocumentSubscribe hook failed");
        }
      })();
    }
  }

  private notifyDocumentUnsubscribe(connectionId: string, documentId: string): void {
    const handler = this.onDocumentUnsubscribe;
    if (handler) {
      void (async () => {
        try {
          await handler(connectionId, documentId);
        } catch (error) {
          this.logger.warn?.({ connectionId, documentId, err: error }, "onDocumentUnsubscribe hook failed");
        }
      })();
    }
  }
}

const DEFAULT_NAMESPACE = "default";

function detectCodec(data: Uint8Array): CodecName {
  if (data.length === 0) {
    return "json";
  }
  const first = data[0];
  if (first === 0x7b || first === 0x5b || first === 0x22) {
    return "json";
  }
  return "messagepack";
}

function channelOf(envelope: { channel?: string; payload?: unknown }): string | undefined {
  if (typeof envelope.channel === "string" && envelope.channel.length > 0) {
    return envelope.channel;
  }
  const payload = envelope.payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record.channel === "string") {
      return record.channel;
    }
    if (typeof record.roomId === "string") {
      return record.roomId;
    }
  }
  return undefined;
}

function documentIdOf(envelope: { channel?: string; payload?: unknown }): string | undefined {
  const payload = envelope.payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record.documentId === "string") {
      return record.documentId;
    }
  }
  return channelOf(envelope);
}

export function createHub(options: HubOptions = {}): Hub {
  return new Hub(options);
}

