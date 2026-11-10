/**
 * LWW map fields.
 *
 * Implements docs/collab/collaboration-engine.md §7 and
 * docs/collab/collaboration-engine-architecture-plan.md §5.5.
 *
 * Per-key register ordered by the tuple `(logicalTime, actorId, counter)`:
 *   - `logicalTime = max(localLogicalTime, observedLogicalTime) + 1` on local
 *     write (Lamport clock).
 *   - Compare logical time first, then actor id, then counter.
 *   - Deletion stored as a tombstone register.
 *   - Concurrent writes to one key keep only one winner (deterministic).
 *
 * Product note: concurrent map writes intentionally keep only one winner.
 */

import type {
  CrdtOperation,
  JsonValue,
  LwwRegister,
  MapDeleteOperation,
  MapSetOperation,
} from "./types.js";
import { CORE_LIMITS } from "./types.js";
import { depsSatisfied as depsSatisfiedVc } from "./vector-clock.js";

export class LwwMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Compare two (logicalTime, actorId, counter) ordering tuples. */
export function compareLwwOrder(
  a: { logicalTime: number; actorId: string; counter: number },
  b: { logicalTime: number; actorId: string; counter: number },
): number {
  if (a.logicalTime !== b.logicalTime) {
    return a.logicalTime < b.logicalTime ? -1 : 1;
  }
  if (a.actorId < b.actorId) return -1;
  if (a.actorId > b.actorId) return 1;
  if (a.counter < b.counter) return -1;
  if (a.counter > b.counter) return 1;
  return 0;
}

export function lwwOrderKey(
  reg: LwwRegister,
): { logicalTime: number; actorId: string; counter: number } {
  return {
    logicalTime: reg.logicalTime,
    actorId: reg.actorId,
    counter: reg.counter,
  };
}

export interface LwwMapOptions {
  maxKeys?: number;
  maxValueBytes?: number;
}

export class LwwMap {
  private readonly registers = new Map<string, LwwRegister>();
  private readonly maxKeys: number;
  private readonly maxValueBytes: number;

  constructor(options: LwwMapOptions = {}) {
    this.maxKeys = options.maxKeys ?? CORE_LIMITS.maxMapKeys;
    this.maxValueBytes = options.maxValueBytes ?? CORE_LIMITS.maxOpSizeBytes;
  }

  /** Current readable map: deleted keys omitted. */
  getMap(): Map<string, JsonValue> {
    const out = new Map<string, JsonValue>();
    for (const [key, reg] of this.registers) {
      if (!reg.deleted) {
        out.set(key, reg.value);
      }
    }
    return out;
  }

  /** Whether a key is currently present (not deleted). */
  has(key: string): boolean {
    const reg = this.registers.get(key);
    return Boolean(reg && !reg.deleted);
  }

  /** Get a key's value, or undefined if deleted/absent. */
  get(key: string): JsonValue | undefined {
    const reg = this.registers.get(key);
    if (!reg || reg.deleted) {
      return undefined;
    }
    return reg.value;
  }

  /** Number of keys tracked (including tombstones). */
  size(): number {
    return this.registers.size;
  }

  /** All registers including tombstones. */
  getRegisters(): LwwRegister[] {
    return [...this.registers.values()];
  }

  /**
   * Apply a map.set operation. The winning register for the key is the one
   * with the greatest (logicalTime, actorId, counter).
   */
  set(op: MapSetOperation): void {
    if (!depsSatisfiedVc({}, op.deps)) {
      // Deps are enforced at the engine level; here we trust the op.
    }
    const valueBytes = new TextEncoder().encode(
      JSON.stringify(op.value),
    ).byteLength;
    if (valueBytes > this.maxValueBytes) {
      throw new LwwMapError(`Map value for ${op.key} exceeds max bytes`);
    }
    const incoming: LwwRegister = {
      key: op.key,
      value: op.value,
      deleted: false,
      logicalTime: op.logicalTime,
      actorId: op.opId.actorId,
      counter: op.opId.counter,
    };
    const existing = this.registers.get(op.key);
    if (!existing) {
      this.registers.set(op.key, incoming);
      return;
    }
    if (compareLwwOrder(lwwOrderKey(incoming), lwwOrderKey(existing)) > 0) {
      this.registers.set(op.key, incoming);
    }
    // Otherwise existing wins (concurrent write keeps one winner).
  }

  /**
   * Apply a map.delete operation: store a tombstone register if it wins.
   */
  delete(op: MapDeleteOperation): void {
    const incoming: LwwRegister = {
      key: op.key,
      value: null,
      deleted: true,
      logicalTime: op.logicalTime,
      actorId: op.opId.actorId,
      counter: op.opId.counter,
    };
    const existing = this.registers.get(op.key);
    if (!existing) {
      this.registers.set(op.key, incoming);
      return;
    }
    if (compareLwwOrder(lwwOrderKey(incoming), lwwOrderKey(existing)) > 0) {
      this.registers.set(op.key, incoming);
    }
  }

  /** Apply a generic map op. */
  apply(op: CrdtOperation): void {
    if (op.kind === "map.set") {
      this.set(op);
    } else if (op.kind === "map.delete") {
      this.delete(op);
    } else {
      throw new LwwMapError(`Unsupported map op kind: ${op.kind}`);
    }
  }
}
