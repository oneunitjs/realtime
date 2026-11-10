/**
 * Collaboration Engine server-side: storage contract.
 *
 * Implements docs/collab/collaboration-engine.md §12 and
 * docs/collab/collaboration-engine-architecture-plan.md §7.3, §9.
 *
 * The storage backend is the source of truth for collaborative document
 * state. The in-memory CRDT engine is a recoverable projection, not the
 * durable database.
 *
 * Every read and write is scoped to a composite document identity
 * `{ tenantId, documentId }` so that one tenant's documents can never leak
 * into another's at the persistence layer.
 */

import type {
  CrdtOperation,
  VectorClock,
} from "../core/types.js";
import type {
  DocumentScope,
} from "./document-key.js";

export interface AppendOperationResult {
  accepted: boolean;
  duplicate: boolean;
  conflict: boolean;
  head: VectorClock;
}

/** Persistent collaboration storage backend. */
export interface CollaborationStorage {
  getOperationsSince(
    scope: DocumentScope,
    vector: VectorClock,
  ): Promise<CrdtOperation[]>;

  appendOperation(
    scope: DocumentScope,
    operation: CrdtOperation,
  ): Promise<AppendOperationResult>;

  getHead(scope: DocumentScope): Promise<VectorClock>;

  getSnapshot(scope: DocumentScope): Promise<unknown | null>;

  saveSnapshot(
    scope: DocumentScope,
    snapshot: unknown,
  ): Promise<void>;
}

/** In-memory storage backend for tests and development. */
export class MemoryStorage implements CollaborationStorage {
  private readonly ops = new Map<string, CrdtOperation[]>();
  private readonly heads = new Map<string, VectorClock>();
  private readonly snapshots = new Map<string, unknown>();

  private key(scope: DocumentScope): string {
    return JSON.stringify([scope.tenantId, scope.documentId]);
  }

  async getOperationsSince(
    scope: DocumentScope,
    vector: VectorClock,
  ): Promise<CrdtOperation[]> {
    const ops = this.ops.get(this.key(scope)) ?? [];
    return ops.filter(({ opId }) => {
      const actor = opId.actorId;
      return (vector[actor] ?? 0) < opId.counter;
    });
  }

  async appendOperation(
    scope: DocumentScope,
    operation: CrdtOperation,
  ): Promise<AppendOperationResult> {
    const key = this.key(scope);
    const ops = this.ops.get(key) ?? [];
    const existing = ops.find(
      ({ opId }) =>
        opId.actorId === operation.opId.actorId &&
        opId.counter === operation.opId.counter,
    );

    if (existing) {
      const identical =
        JSON.stringify(existing) === JSON.stringify(operation);
      if (identical) {
        return {
          accepted: true,
          duplicate: true,
          conflict: false,
          head: { ...(this.heads.get(key) ?? {}) },
        };
      }
      return {
        accepted: false,
        duplicate: false,
        conflict: true,
        head: { ...(this.heads.get(key) ?? {}) },
      };
    }

    ops.push(operation);
    this.ops.set(key, ops);

    const actor = operation.opId.actorId;
    const head = this.heads.get(key) ?? {};
    head[actor] = Math.max(head[actor] ?? 0, operation.opId.counter);
    this.heads.set(key, head);

    return {
      accepted: true,
      duplicate: false,
      conflict: false,
      head: { ...head },
    };
  }

  async getHead(scope: DocumentScope): Promise<VectorClock> {
    return { ...(this.heads.get(this.key(scope)) ?? {}) };
  }

  async getSnapshot(scope: DocumentScope): Promise<unknown | null> {
    return this.snapshots.get(this.key(scope)) ?? null;
  }

  async saveSnapshot(
    scope: DocumentScope,
    snapshot: unknown,
  ): Promise<void> {
    this.snapshots.set(this.key(scope), snapshot);
  }
}
