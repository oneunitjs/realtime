/**
 * Collaboration Engine server-side: sync handler.
 *
 * Implements docs/collab/collaboration-engine.md §9.1 and
 * docs/collab/collaboration-engine-architecture-plan.md §8.1.
 *
 * Handles sync requests and operation submission. Every incoming operation is
 * validated (schema, actor binding, ownership, document permission, limits)
 * through OpValidator before it is appended to the document-scoped OpLog.
 * All reads and writes are scoped to `{ tenantId, documentId }`, so one
 * document's operations can never leak into another.
 */

import type {
  CrdtOperation,
  VectorClock,
} from "../core/types.js";
import type { OpLog } from "./op-log.js";
import { OpValidator, ValidationError } from "./validator.js";
import type { DocumentAcl } from "./acl.js";
import type {
  AuthenticatedPrincipal,
} from "./principal.js";
import type { DocumentScope } from "./document-key.js";

export interface SyncRequest {
  scope: DocumentScope;
  documentId: string;
  schemaVersion: number;
  have: VectorClock;
}

export interface SyncResponse {
  operations: CrdtOperation[];
  head: VectorClock;
}

export interface SyncHandlerDeps {
  opLog: OpLog;
  acl: DocumentAcl;
  validators?: { validateSchemaVersion(v: unknown): number };
}

export class SyncHandler {
  private readonly validator: OpValidator;

  constructor(private readonly deps: SyncHandlerDeps) {
    this.validator = new OpValidator({
      acl: deps.acl,
    });
  }

  async sync(request: SyncRequest): Promise<SyncResponse> {
    const schemaVersion = this.deps.validators?.validateSchemaVersion
      ? this.deps.validators.validateSchemaVersion(request.schemaVersion)
      : request.schemaVersion;

    if (schemaVersion !== 1) {
      throw new Error(`Unsupported schema version: ${schemaVersion}`);
    }

    const operations = this.deps.opLog.since(request.scope, request.have);
    const head = this.deps.opLog.getHead(request.scope);

    return {
      operations,
      head,
    };
  }

  /**
   * Handle an inbound operation: validate (schema, actor binding, ownership,
   * ACL, limits), then durably append to the document-scoped OpLog.
   * Returns the durable ACK shape or a rejection indication.
   */
  async handleOperation(params: {
    scope: DocumentScope;
    documentId: string;
    operation: CrdtOperation;
    connectionId: string;
    principal: AuthenticatedPrincipal;
  }): Promise<{
    status: "persisted" | "duplicate" | "conflict" | "rejected";
    head?: VectorClock;
    reason?: string;
    code?: string;
  }> {
    const { scope, documentId, operation, principal } = params;

    // 1. Actor binding: the operation's opId.actorId must match the actor
    //    authenticated for this connection. Prevents actor spoofing.
    if (operation.opId.actorId !== principal.actorId) {
      return {
        status: "rejected",
        reason: "INVALID_ACTOR",
        code: "INVALID_ACTOR",
      };
    }

    // 2. Full operation validation: schema, actor binding, actor ownership,
    //    document write permission, allowed keys, size, deps.
    let validated: CrdtOperation;
    try {
      validated = await this.validator.validate({
        operation,
        documentId,
        principal: {
          userId: principal.userId,
          tenantId: principal.tenantId,
          actorId: principal.actorId,
          roles: principal.roles ?? [],
        },
        actorId: principal.actorId,
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        return { status: "rejected", reason: error.code, code: error.code };
      }
      return { status: "rejected", reason: String(error) };
    }

    // 3. Durable append, scoped to the document.
    const result = await this.deps.opLog.append(scope, validated);
    if (result.conflict) {
      return { status: "conflict", reason: "Op ID conflict", code: "OP_ID_CONFLICT" };
    }
    return {
      status: result.duplicate ? "duplicate" : "persisted",
      head: result.head,
    };
  }
}
