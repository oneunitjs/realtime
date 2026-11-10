/**
 * Collaboration Engine server-side: sync handler.
 *
 * Implements docs/collab/collaboration-engine.md §9.1 and
 * docs/collab/collaboration-engine-architecture-plan.md §8.1.
 *
 * Handles sync requests: validates schema version, returns missing
 * operations or a snapshot + tail operations based on the client's vector
 * clock.
 */

import type {
  CrdtOperation,
  Snapshot,
  VectorClock,
} from "../core/types.js";
import type { OpLog } from "./op-log.js";

export interface SyncRequest {
  documentId: string;
  schemaVersion: number;
  have: VectorClock;
}

export interface SyncResponse {
  snapshot?: Snapshot;
  operations: CrdtOperation[];
  head: VectorClock;
}

export interface SyncHandlerDeps {
  opLog: OpLog;
  validators?: { validateSchemaVersion(v: unknown): number };
}

export class SyncHandler {
  constructor(private readonly deps: SyncHandlerDeps) {}

  async sync(request: SyncRequest): Promise<SyncResponse> {
    const schemaVersion = this.deps.validators?.validateSchemaVersion
      ? this.deps.validators.validateSchemaVersion(request.schemaVersion)
      : request.schemaVersion;

    if (schemaVersion !== 1) {
      throw new Error(`Unsupported schema version: ${schemaVersion}`);
    }

    const operations = this.deps.opLog.since(request.have);
    const head = this.deps.opLog.getHead();

    return {
      operations,
      head,
    };
  }

  /**
   * Handle an inbound operation: validate, append, ACK, fan out.
   * Returns the durable ACK shape or an error indication.
   */
  async handleOperation(params: {
    operation: CrdtOperation;
    connectionId: string;
    principal: { userId: string };
  }): Promise<{
    status: "persisted" | "duplicate" | "conflict" | "rejected";
    head?: VectorClock;
    reason?: string;
  }> {
    const result = this.deps.opLog.append(params.operation);
    if (result.conflict) {
      // Same op ID, different payload → protocol violation.
      return { status: "conflict", reason: "Op ID conflict" };
    }
    if (result.accepted) {
      return {
        status: result.duplicate ? "duplicate" : "persisted",
        head: result.head,
      };
    }
    return { status: "rejected", reason: "Operation rejected" };
  }
}
