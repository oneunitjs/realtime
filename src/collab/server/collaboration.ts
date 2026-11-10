/**
 * Server-side collaboration module.
 *
 * Composes OpLog, OpValidator, ACL, and SyncHandler into a middleware that
 * can be attached to a Realtime server. Provides document-level
 * authorization, durable operation logging, and vector-clock sync.
 *
 * Example:
 *
 *   import { Realtime } from "@oneunit/realtime/server";
   *   import { collaboration } from "@oneunit/realtime/collab";
   *
   *   const io = new Realtime({ transport: "uwebsockets" });
   *   const collab = collaboration({
   *     storage: myStorage,
   *     authenticate: async (request) => authenticateUser(request),
   *     authorize: async ({ user, document, permission }) => {
   *       return checkDocumentPermission(user, document.id, permission);
   *     },
   *   });
   *
   *   io.use(collab.middleware());
   *   await io.listen(3000);
   */

import type {
  CrdtOperation,
  ElementId,
  VectorClock,
} from "../core/types.js";
import { OpLog } from "./op-log.js";
import { OpValidator } from "./validator.js";
import { AllowAllAcl, type DocumentAcl } from "./acl.js";
import { SyncHandler } from "./sync-handler.js";

/** Collaboration server options. */
export interface CollaborationOptions {
  /** Document storage backend (operation log, snapshots, etc.). */
  storage: {
    getOperationsSince(vector: VectorClock): Promise<CrdtOperation[]>;
    appendOperation(operation: CrdtOperation): Promise<{
      accepted: boolean;
      duplicate: boolean;
      conflict: boolean;
      head: VectorClock;
    }>;
    getHead(): Promise<VectorClock>;
  };
  /** Authenticate a WebSocket connection. Returns actor identity or null. */
  authenticate: (
    request: { url?: string; headers?: Record<string, string> },
  ) => Promise<{ userId: string; actorId: string } | null>;
  /** Authorize a document action for a principal. */
  authorize: (
    params: {
      principal: { userId: string };
      documentId: string;
      permission: "read" | "write";
    },
  ) => Promise<boolean>;
}

/** Created collaboration module. */
export interface Collaboration {
  /** Express/Koa-style middleware for the Realtime server socket. */
  middleware(): (socket: any, next: () => void) => void;
  /** Access to the underlying OpLog (advanced). */
  getOpLog(): OpLog;
  /** Access to the underlying SyncHandler (advanced). */
  getSyncHandler(): SyncHandler;
}

/**
 * Create a collaboration module for a Realtime server.
 *
 * Wraps OpLog, OpValidator, ACL, and SyncHandler into middleware that
 * authenticates connections, authorizes document access, handles sync
 * requests, and fans out operations to subscribed clients.
 */
export function collaboration(options: CollaborationOptions): Collaboration {
  const opLog = new OpLog({
    now: Date.now,
  });
  const validator = new OpValidator({
    acl: options.storage as unknown as import("./acl.js").DocumentAcl,
    actorOwner: new Map(),
  });
  const syncHandler = new SyncHandler({
    opLog,
    validators: {
      validateSchemaVersion: (v: unknown) => {
        if (v !== 1) throw new Error(`Unsupported schema version: ${v}`);
        return v;
      },
    },
  });

  // Track document -> set of socket IDs subscribed to it
  const docSockets = new Map<string, Set<string>>();

  function middleware() {
    return (socket: any, next: () => void) => {
      // Authenticate on connection
      socket.data = socket.data || {};
      socket.data.authenticated = false;
      socket.data.actorId = null;
      socket.data.userId = null;
      socket.data.syncVectors = socket.data.syncVectors || {};

      // Attach document subscription handlers
      const originalJoin = socket.join.bind(socket);
      socket.join = (room: string) => {
        if (!docSockets.has(room)) {
          docSockets.set(room, new Set());
        }
        docSockets.get(room)!.add(socket.id);
        originalJoin(room);
      };

      const originalLeave = socket.leave.bind(socket);
      socket.leave = (room: string) => {
        docSockets.get(room)?.delete(socket.id);
        originalLeave(room);
      };

      // Handle document open / initial sync
      socket.on("document.open", async (data: { documentId: string }) => {
        if (!socket.data.authenticated) {
          socket.emit("error", { code: "UNAUTHORIZED", message: "Not authenticated" });
          return;
        }
        const { documentId } = data;
        const canRead = await options.authorize({
          principal: { userId: socket.data.userId! },
          documentId,
          permission: "read",
        });
        if (!canRead) {
          socket.emit("error", { code: "DOCUMENT_FORBIDDEN", message: `No read access to ${documentId}` });
          return;
        }
        socket.join(documentId);

        // Send initial sync
        const have = socket.data.syncVectors[documentId] ?? {};
        const ops = opLog.since(have);
        const head = opLog.getHead();
        socket.emit("sync.response", {
          operations: ops,
          head,
          documentId,
        });
        socket.data.syncVectors = { ...socket.data.syncVectors, [documentId]: head };
      });

      // Handle operation submission
      socket.on("operation.push", async (data: { documentId: string; operation: CrdtOperation }) => {
        if (!socket.data.authenticated) {
          socket.emit("error", { code: "UNAUTHORIZED", message: "Not authenticated" });
          return;
        }
        const { documentId, operation } = data;
        const canWrite = await options.authorize({
          principal: { userId: socket.data.userId! },
          documentId,
          permission: "write",
        });
        if (!canWrite) {
          socket.emit("error", { code: "DOCUMENT_FORBIDDEN", message: `No write access to ${documentId}` });
          return;
        }

        try {
          const result = await syncHandler.handleOperation({
            operation,
            connectionId: socket.id,
            principal: { userId: socket.data.userId! },
          });

          if (result.status === "persisted" || result.status === "duplicate") {
            // Fan out to other sockets in the same document
            socket.emit("operation.ack", {
              opId: operation.opId,
              head: result.head,
            });
          } else if (result.status === "conflict") {
            socket.emit("error", { code: "ACTOR_CONFLICT", message: "Operation ID conflict" });
          } else {
            socket.emit("error", { code: "INVALID_OPERATION", message: result.reason });
          }
        } catch (error) {
          socket.emit("error", { code: "VALIDATION_FAILED", message: error instanceof Error ? error.message : String(error) });
        }
      });

      // Authenticate the socket
      (async () => {
        try {
          const result = await options.authenticate({
            url: "",
            headers: {},
          });
          if (result) {
            socket.data.authenticated = true;
            socket.data.actorId = result.actorId;
            socket.data.userId = result.userId;
            socket.emit("auth.success", { actorId: result.actorId, userId: result.userId });
          } else {
            socket.emit("error", { code: "UNAUTHORIZED", message: "Authentication failed" });
          }
        } catch (error) {
          socket.emit("error", { code: "UNAUTHORIZED", message: error instanceof Error ? error.message : String(error) });
        }
      })();

      next();
    };
  }

  return {
    middleware,
    getOpLog: () => opLog,
    getSyncHandler: () => syncHandler,
  };
}
