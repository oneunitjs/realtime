/**
 * Collaboration Engine server-side: append-only operation log.
 *
 * Implements docs/collab/collaboration-engine.md §12.1 and
 * docs/collab/collaboration-engine-architecture-plan.md §7.3, §9.1.
 *
 * Records accepted operations durably (in-memory by default) and advances
 * the document head atomically. Append-only: an operation may not be
 * mutated after it is appended.
 */

import type { CrdtOperation, ElementId, VectorClock } from "../core/types.js";

export interface StoredOperation {
  operation: CrdtOperation;
  storedAt: number;
}

export interface OpLogDeps {
  now?: () => number;
}

export class OpLog {
  private readonly ops: StoredOperation[] = [];
  private readonly opIndex = new Map<string, StoredOperation>();
  private readonly counterparties = new Map<string, string>(); // op id → payload hash
  private head: VectorClock = {};

  constructor(private readonly deps: OpLogDeps = {}) {}

  /** Append an operation durably. Returns the durable ACK shape. */
  append(op: CrdtOperation): {
    accepted: boolean;
    duplicate: boolean;
    conflict: boolean;
    head: VectorClock;
  } {
    const idKey = `${op.opId.actorId}\x00${op.opId.counter}`;
    const payloadHash = JSON.stringify(op);

    const existing = this.opIndex.get(idKey);
    if (existing) {
      if (JSON.stringify(existing.operation) === payloadHash) {
        // Idempotent: same ID + same payload → return existing.
        return { accepted: true, duplicate: true, conflict: false, head: { ...this.head } };
      }
      // Same ID + different payload → conflict.
      return { accepted: false, duplicate: false, conflict: true, head: { ...this.head } };
    }

    this.ops.push({
      operation: op,
      storedAt: this.deps.now ? this.deps.now() : Date.now(),
    });
    this.opIndex.set(idKey, this.ops[this.ops.length - 1]);

    // Advance document head.
    this.updateHead(op.opId);

    return {
      accepted: true,
      duplicate: false,
      conflict: false,
      head: { ...this.head },
    };
  }

  /** Get all operations at or after a given version vector (for sync). */
  since(vector: VectorClock): CrdtOperation[] {
    const out: CrdtOperation[] = [];
    for (const stored of this.ops) {
      const env = stored.operation;
      const opId = env.opId;
      if ((vector[opId.actorId] ?? 0) < opId.counter) {
        out.push(env);
      }
    }
    return out;
  }

  /** Get all operations (full log). */
  all(): CrdtOperation[] {
    return this.ops.map((s) => s.operation);
  }

  /** Get the head version vector. */
  getHead(): VectorClock {
    return { ...this.head };
  }

  /** Number of stored operations. */
  size(): number {
    return this.ops.length;
  }

  private updateHead(opId: ElementId): void {
    const current = this.head[opId.actorId] ?? 0;
    if (opId.counter > current) {
      this.head[opId.actorId] = opId.counter;
    }
  }
}
