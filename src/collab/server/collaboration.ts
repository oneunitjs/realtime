/**
 * Server-side collaboration module.
 *
 * Composes OpLog, OpValidator, ACL, SyncHandler, subscriptions, and
 * broadcaster into middleware that authenticates connections, authorizes
 * document access, handles sync requests, validates and persists
 * operations, and fans them out to subscribed clients.
 *
 * All operation processing is scoped to a composite document identity
 * `{ tenantId, documentId }`: storage, synchronization, validation, and
 * fan-out are partitioned by document scope, so one document's (or one
 * tenant's) operations never leak into another's.
 *
 * The collaboration pipeline:
 *
 *   document.open
 *     → authenticate (real handshake context)
 *     → resolve tenant/document from authenticated principal
 *     → authorize read
 *     → subscribe (scope-keyed)
 *     → sync (document-scoped, missing operations only)
 *
 *   operation.push
 *     → authenticate
 *     → resolve tenant/document from authenticated principal
 *     → authorize write
 *     → validate actor binding + operation (OpValidator)
 *     → persist atomically (OpLog + storage backend)
 *     → ACK sender
 *     → broadcast to other authorized subscribers (broadcaster/outbox)
 *
 * Example:
 *
 *   import { Realtime } from "@oneunit/realtime/server";
 *   import { collaboration } from "@oneunit/realtime/collab";
 *
 *   const io = new Realtime({ transport: "uwebsockets" });
 *   const collab = collaboration({
 *     storage: myStorage,
 *     authenticate: async (context) => authenticateUser(context),
 *     authorize: async ({ principal, documentId, permission }) => {
 *       return checkDocumentPermission(principal, documentId, permission);
 *     },
 *   });
 *
 *   io.use(collab.middleware());
 *   await io.listen(3000);
 */

import type {
  CrdtOperation,
  VectorClock,
} from "../core/types.js";
import { OpLog } from "./op-log.js";
import { OpValidator } from "./validator.js";
import type { DocumentAcl } from "./acl.js";
import { SyncHandler } from "./sync-handler.js";
import type {
  AuthenticatedPrincipal,
} from "./principal.js";
import {
  documentScopeKey,
  type DocumentScope,
} from "./document-key.js";
import type { CollaborationStorage } from "./storage.js";
import type { DocumentSubscriptions } from "./subscriptions.js";
import { MemoryDocumentSubscriptions } from "./subscriptions.js";
import type { CollaborationBroadcaster } from "./broadcaster.js";
import { MemoryBroadcaster } from "./broadcaster.js";

/** Collaboration server options. */
export interface CollaborationOptions {
  /** Document storage backend (operation log, snapshots, etc.). */
  storage?: CollaborationStorage;

  /** Authenticate a WebSocket connection using the real handshake context. */
  authenticate: (
    context: { url?: string; headers?: Record<string, string> },
  ) => Promise<AuthenticatedPrincipal | null>;

  /** Authorize a document action for an authenticated principal. */
  authorize: (
    params: {
      principal: AuthenticatedPrincipal;
      documentId: string;
      permission: "read" | "write";
    },
  ) => Promise<boolean>;

  /** Optional transport-independent send function for broadcasting. */
  send?: (
    connectionId: string,
    envelope: unknown,
  ) => Promise<{ status: "accepted" | "buffered" | "dropped" }>;

  /** Optional outbox store for crash-safe broadcast delivery. */
  outbox?: {
    append(entry: {
      id: string;
      scope: DocumentScope;
      operation: CrdtOperation;
      excludeConnectionId?: string;
      status: "pending" | "sent" | "failed";
      attempts: number;
      createdAt: number;
      updatedAt: number;
    }): Promise<void>;
    listPending(): Promise<Array<{
      id: string;
      scope: DocumentScope;
      operation: CrdtOperation;
      excludeConnectionId?: string;
      status: "pending" | "sent" | "failed";
      attempts: number;
      createdAt: number;
      updatedAt: number;
    }>>;
    markSent(id: string): Promise<void>;
    markFailed(id: string): Promise<void>;
  };
}

/** Created collaboration module. */
export interface Collaboration {
  /** Express/Koa-style middleware for the Realtime server socket. */
  middleware(): (socket: any, next: () => void) => void;
  /** Access to the underlying OpLog (advanced). */
  getOpLog(): OpLog;
  /** Access to the underlying SyncHandler (advanced). */
  getSyncHandler(): SyncHandler;
  /** Access to the underlying broadcaster (advanced). */
  getBroadcaster(): CollaborationBroadcaster;
}

/**
 * Best-effort extraction of handshake information from a socket-like object.
 * Supports Socket.IO-style (`socket.handshake`) and raw request-style
 * (`socket.request` / socket.url` / `socket.headers`) shapes.
 */
function extractHandshake(socket: any): {
  url?: string;
  headers: Record<string, string>;
} {
  const handshake = socket?.handshake ?? socket?.request ?? {};
  const url =
    handshake?.url ??
    socket?.url ??
    socket?.request?.url ??
    undefined;
  const headers: Record<string, string> =
    typeof handshake?.headers === "object" && handshake?.headers !== null
      ? handshake.headers
      : {};
  return { url, headers };
}

/**
 * Wrap the collaboration `authorize` hook as a DocumentAcl for the
 * OpValidator. These are related but distinct contracts.
 */
function toDocumentAcl(
  authorize: CollaborationOptions["authorize"],
): DocumentAcl {
  return {
    canRead: (principal, documentId) =>
      authorize({
        principal,
        documentId,
        permission: "read",
      }),
    canWrite: (principal, documentId) =>
      authorize({
        principal,
        documentId,
        permission: "write",
      }),
  };
}

/**
 * Build the composite document scope from an authenticated principal and a
 * document id. Tenant id comes from the principal (server-authenticated),
 * never from an untrusted client request.
 */
function scopeFor(
  principal: AuthenticatedPrincipal,
  documentId: string,
): DocumentScope {
  return {
    tenantId: principal.tenantId,
    documentId,
  };
}

/**
 * Create a collaboration module for a Realtime server.
 */
export function collaboration(options: CollaborationOptions): Collaboration {
  const opLog = new OpLog({
    now: Date.now,
    storage: options.storage,
  });

  const actorOwner = new Map<string, string>();
  const validatorAcl = toDocumentAcl(options.authorize);
  const syncHandler = new SyncHandler({
    opLog,
    acl: validatorAcl,
  });

  const subscriptions: DocumentSubscriptions = new MemoryDocumentSubscriptions();
  const broadcaster = new MemoryBroadcaster(
    subscriptions,
    options.send ?? (async () => ({ status: "accepted" as const })),
    options.outbox,
  );

  // Track client-applied sync frontiers per connection, keyed by document
  // scope. Only advanced when the client explicitly acknowledges a sync
  // response (sync.applied), so an unacknowledged response is never treated
  // as fully applied.
  const clientFrontiers = new Map<string, Map<string, VectorClock>>();
  function middleware() {
    return (socket: any, next: () => void) => {
      socket.data = socket.data || {};
      socket.data.authenticated = false;
      socket.data.principal = null;
      socket.data.syncVectors = socket.data.syncVectors || {};

      (async () => {
        try {
          const { url, headers } = extractHandshake(socket);
          const result = await options.authenticate({ url, headers });
          if (result) {
            socket.data.authenticated = true;
            socket.data.principal = result;
            actorOwner.set(result.actorId, result.userId);
            socket.emit("auth.success", {
              actorId: result.actorId,
              userId: result.userId,
              tenantId: result.tenantId,
            });
          } else {
            socket.emit("error", {
              code: "UNAUTHORIZED",
              message: "Authentication failed",
            });
          }
        } catch (error) {
          socket.emit("error", {
            code: "UNAUTHORIZED",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();

      const originalJoin = socket.join.bind(socket);
      socket.join = (room: string) => {
        originalJoin(room);
      };

      const originalLeave = socket.leave.bind(socket);
      socket.leave = (room: string) => {
        originalLeave(room);
      };

      // Clean up all subscriptions on disconnect.
      const onDisconnect = () => {
        subscriptions.removeConnection(socket.id);
        clientFrontiers.delete(socket.id);
      };
      socket.once?.("disconnect", onDisconnect);
      socket.once?.("close", onDisconnect);

      // Handle document open / initial sync
      socket.on("document.open", async (data: { documentId: string }) => {
        if (!socket.data.authenticated || !socket.data.principal) {
          socket.emit("error", {
            code: "UNAUTHORIZED",
            message: "Not authenticated",
          });
          return;
        }
        const principal = socket.data.principal;
        const { documentId } = data;
        const scope = scopeFor(principal, documentId);
        const scopeKey = documentScopeKey(scope);

        const canRead = await options.authorize({
          principal,
          documentId,
          permission: "read",
        });
        if (!canRead) {
          socket.emit("error", {
            code: "DOCUMENT_FORBIDDEN",
            message: `No read access to ${documentId}`,
          });
          return;
        }

        subscriptions.subscribe(scope, socket.id);
        socket.join(documentId);

        // Load durable history into the in-memory log on first access after
        // a restart, so clients can recover collaborative state.
        if (
          !opLog.isLoaded(scope) &&
          options.storage
        ) {
          try {
            const stored = await options.storage.getOperationsSince(
              scope,
              {},
            );
            opLog.replay(scope, stored);
          } catch {
            // Best-effort history load; proceed with whatever is in memory.
          }
        }

        // Send initial sync (document-scoped: no cross-document leakage).
        const clientFrontierMap = clientFrontiers.get(socket.id);
        const have = clientFrontierMap?.get(scopeKey) ?? {};
        const ops = opLog.since(scope, have);
        const head = opLog.getHead(scope);

        socket.emit("sync.response", {
          operations: ops,
          head,
          documentId,
          tenantId: principal.tenantId,
          scope,
        });

        // Record that this sync response has been sent but not yet
        // acknowledged as applied by the client.
      });

      // Explicit client acknowledgement that a sync response was received,
      // validated, and applied. Only then is the client's applied frontier
      // advanced, preventing the server from treating an unconfirmed
      // synchronization as completed.
      socket.on("sync.applied", async (data: {
        documentId: string;
        vector: VectorClock;
      }) => {
        if (!socket.data.authenticated || !socket.data.principal) {
          socket.emit("error", {
            code: "UNAUTHORIZED",
            message: "Not authenticated",
          });
          return;
        }
        const principal = socket.data.principal;
        const { documentId, vector } = data;
        const scope = scopeFor(principal, documentId);
        const scopeKey = documentScopeKey(scope);

        // Re-verify read authorization before recording the frontier.
        const canRead = await options.authorize({
          principal,
          documentId,
          permission: "read",
        });
        if (!canRead) {
          socket.emit("error", {
            code: "DOCUMENT_FORBIDDEN",
            message: `No read access to ${documentId}`,
          });
          return;
        }

        let frontiers = clientFrontiers.get(socket.id);
        if (!frontiers) {
          frontiers = new Map();
          clientFrontiers.set(socket.id, frontiers);
        }
        frontiers.set(scopeKey, { ...vector });

        socket.emit("sync.applied.ack", {
          documentId,
          scope,
        });
      });

      // Handle operation submission
      socket.on("operation.push", async (data: {
        documentId: string;
        operation: CrdtOperation;
      }) => {
        if (!socket.data.authenticated || !socket.data.principal) {
          socket.emit("error", {
            code: "UNAUTHORIZED",
            message: "Not authenticated",
          });
          return;
        }
        const principal = socket.data.principal;
        const { documentId, operation } = data;
        const scope = scopeFor(principal, documentId);

        const canWrite = await options.authorize({
          principal,
          documentId,
          permission: "write",
        });
        if (!canWrite) {
          socket.emit("error", {
            code: "DOCUMENT_FORBIDDEN",
            message: `No write access to ${documentId}`,
          });
          return;
        }

        try {
          const result = await syncHandler.handleOperation({
            scope,
            documentId,
            operation,
            connectionId: socket.id,
            principal,
          });

          if (result.status === "persisted" || result.status === "duplicate") {
            // Fan out to other subscribers of the same document scope after
            // the operation is durably committed.
            const broadcastResult = await broadcaster.broadcast(scope, operation, {
              excludeConnectionId: socket.id,
              send: options.send,
            });

            socket.emit("operation.ack", {
              opId: operation.opId,
              head: result.head,
              broadcast: {
                accepted: broadcastResult.accepted,
                buffered: broadcastResult.buffered,
                dropped: broadcastResult.dropped,
                failed: broadcastResult.failed,
              },
            });
          } else if (result.status === "conflict") {
            socket.emit("error", {
              code: "ACTOR_CONFLICT",
              message: "Operation ID conflict",
            });
          } else {
            socket.emit("error", {
              code: "VALIDATION_FAILED",
              message: result.reason ?? "Operation rejected",
            });
          }
        } catch (error) {
          socket.emit("error", {
            code: "VALIDATION_FAILED",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });

      // Handle snapshot compaction request: server provides a snapshot for
      // the document so the client can compact its local history.
      socket.on("snapshot.request", async (data: {
        documentId: string;
      }) => {
        if (!socket.data.authenticated || !socket.data.principal) {
          socket.emit("error", {
            code: "UNAUTHORIZED",
            message: "Not authenticated",
          });
          return;
        }
        const principal = socket.data.principal;
        const { documentId } = data;
        const scope = scopeFor(principal, documentId);

        const canRead = await options.authorize({
          principal,
          documentId,
          permission: "read",
        });
        if (!canRead) {
          socket.emit("error", {
            code: "DOCUMENT_FORBIDDEN",
            message: `No read access to ${documentId}`,
          });
          return;
        }

        const snapshot = options.storage
          ? await options.storage.getSnapshot(scope)
          : null;
        const head = opLog.getHead(scope);

        socket.emit("snapshot.response", {
          documentId,
          scope,
          head,
          snapshot,
        });
      });

      next();
    };
  }

  return {
    middleware,
    getOpLog: () => opLog,
    getSyncHandler: () => syncHandler,
    getBroadcaster: () => broadcaster,
  };
}
