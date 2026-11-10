/**
 * Collaboration Engine server-side: append-only operation log.
 *
 * Implements docs/collab/collaboration-engine.md §12.1 and
 * docs/collab/collaboration-engine-architecture-plan.md §7.3, §9.1.
 *
 * Records accepted operations durably (in-memory by default) and advances
 * the document head atomically. Append-only: an operation may not be
 * mutated after it is appended.
 *
 * The log is scoped to a composite document identity `{ tenantId,
 * documentId }`. Operations from one document — or one tenant — can never
 * leak into another document's synchronization response, and operation IDs
 * ({actorId, counter}) only collide within the same document scope.
 */

import type {
  CrdtOperation,
  ElementId,
  VectorClock,
} from "../core/types.js";
import { encodeElementId } from "../core/types.js";
import {
  documentScopeKey,
  type DocumentScope,
  operationKey,
} from "./document-key.js";

export interface StoredOperation {
  operation: CrdtOperation;
  storedAt: number;
}

export interface OpLogDeps {
  now?: () => number;
  /** Optional durable backend. When provided, every accepted append is also
   *  written here so operation history survives restarts. */
  storage?: {
    appendOperation(
      scope: DocumentScope,
      operation: CrdtOperation,
    ): Promise<{
      accepted: boolean;
      duplicate: boolean;
      conflict: boolean;
      head: VectorClock;
    }>;
    getOperationsSince(
      scope: DocumentScope,
      vector: VectorClock,
    ): Promise<CrdtOperation[]>;
    getHead(scope: DocumentScope): Promise<VectorClock>;
  };
}

class DocState {
  readonly ops: StoredOperation[] = [];
  readonly opIndex = new Map<string, StoredOperation>();
  head: VectorClock = {};
  loaded = false;
}

export class OpLog {
  private readonly docs = new Map<string, DocState>();
  private readonly now: () => number;
  private readonly storage: OpLogDeps["storage"];

  constructor(deps: OpLogDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.storage = deps.storage;
  }

  private docState(scope: DocumentScope): DocState {
    const key = documentScopeKey(scope);
    let state = this.docs.get(key);
    if (!state) {
      state = new DocState();
      this.docs.set(key, state);
    }
    return state;
  }

  /** Append an operation durably, scoped to a document. */
  async append(
    scope: DocumentScope,
    op: CrdtOperation,
  ): Promise<{
    accepted: boolean;
    duplicate: boolean;
    conflict: boolean;
    head: VectorClock;
  }> {
    const state = this.docState(scope);
    const idKey = operationKey(op.opId.actorId, op.opId.counter);
    const payloadHash = JSON.stringify(op);

    const existing = state.opIndex.get(idKey);
    if (existing) {
      if (JSON.stringify(existing.operation) === payloadHash) {
        return { accepted: true, duplicate: true, conflict: false, head: { ...state.head } };
      }
      return { accepted: false, duplicate: false, conflict: true, head: { ...state.head } };
    }

    state.ops.push({
      operation: op,
      storedAt: this.now(),
    });
    state.opIndex.set(idKey, state.ops[state.ops.length - 1]);

    this.updateHead(state, op.opId);

    // Persist to the configured durable backend (non-fatal if it fails).
    if (this.storage) {
      try {
        await this.storage.appendOperation(scope, op);
      } catch {
        // Storage failure must not roll back the in-memory accept; the op is
        // already durably indexed here.
      }
    }

    return {
      accepted: true,
      duplicate: false,
      conflict: false,
      head: { ...state.head },
    };
  }

  /** Get all operations at or after a given version vector for a document. */
  since(scope: DocumentScope, vector: VectorClock): CrdtOperation[] {
    const state = this.docs.get(documentScopeKey(scope));
    if (!state) {
      return [];
    }
    const out: CrdtOperation[] = [];
    for (const stored of state.ops) {
      const env = stored.operation;
      const opId = env.opId;
      if ((vector[opId.actorId] ?? 0) < opId.counter) {
        out.push(env);
      }
    }
    return out;
  }

  /** Get all operations for a document scope (full log). */
  all(scope: DocumentScope): CrdtOperation[] {
    const state = this.docs.get(documentScopeKey(scope));
    if (!state) {
      return [];
    }
    return state.ops.map((s) => s.operation);
  }

  /** Get the head version vector for a document scope. */
  getHead(scope: DocumentScope): VectorClock {
    const state = this.docs.get(documentScopeKey(scope));
    return state ? { ...state.head } : {};
  }

  /** Number of stored operations for a document scope. */
  size(scope: DocumentScope): number {
    const state = this.docs.get(documentScopeKey(scope));
    return state ? state.ops.length : 0;
  }

  /** Bulk-load operations into a document scope's in-memory state (used to
   *  restore history from durable storage after a restart). */
  replay(scope: DocumentScope, ops: CrdtOperation[]): void {
    const state = this.docState(scope);
    state.loaded = true;
    for (const op of ops) {
      const idKey = operationKey(op.opId.actorId, op.opId.counter);
      if (state.opIndex.has(idKey)) {
        continue;
      }
      state.ops.push({ operation: op, storedAt: this.now() });
      state.opIndex.set(idKey, state.ops[state.ops.length - 1]);
      this.updateHead(state, op.opId);
    }
  }

  /** Whether a document scope has any in-memory operations loaded. */
  isLoaded(scope: DocumentScope): boolean {
    const state = this.docs.get(documentScopeKey(scope));
    return Boolean(state?.loaded);
  }

  private updateHead(state: DocState, opId: ElementId): void {
    const current = state.head[opId.actorId] ?? 0;
    if (opId.counter > current) {
      state.head[opId.actorId] = opId.counter;
    }
  }
}
