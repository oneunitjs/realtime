/**
 * Collaboration Engine core types.
 *
 * Implements docs/collab/collaboration-engine.md §5.2 and
 * docs/collab/collaboration-engine-architecture-plan.md §5.1.
 *
 * Pure, transport- and persistence-independent CRDT core surface.
 */

// ---------------------------------------------------------------------------
// JsonValue
// ---------------------------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Actor / operation identity
// ---------------------------------------------------------------------------

/** Durable client identity issued by the server for a device/session. */
export type ActorId = string;

/** Stable operation identity: { actorId, counter }. */
export interface ElementId {
  actorId: ActorId;
  counter: number;
}

/** Per-actor highest counter observed: version vector. */
export type VectorClock = Record<ActorId, number>;

/** Canonical wire encoding of an ElementId. */
export function encodeElementId(id: ElementId): string {
  return `${id.actorId}\x00${id.counter}`;
}

/** Parse an ElementId from its canonical encoding. */
export function decodeElementId(encoded: string): ElementId {
  const sep = encoded.indexOf("\x00");
  if (sep === -1) {
    throw new Error(`Invalid element id encoding: ${encoded}`);
  }
  const actorId = encoded.slice(0, sep);
  const counter = Number(encoded.slice(sep + 1));
  if (!Number.isFinite(counter) || counter < 0 || !Number.isInteger(counter)) {
    throw new Error(`Invalid counter in element id: ${encoded}`);
  }
  return { actorId, counter };
}

/** Total (actorId, counter) comparator for stable sibling ordering. */
export function compareElementId(a: ElementId, b: ElementId): number {
  if (a.actorId < b.actorId) return -1;
  if (a.actorId > b.actorId) return 1;
  if (a.counter < b.counter) return -1;
  if (a.counter > b.counter) return 1;
  return 0;
}

/** Check element id equality. */
export function elementIdEquals(a: ElementId, b: ElementId): boolean {
  return a.actorId === b.actorId && a.counter === b.counter;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export type CrdtOperationKind =
  | "text.insert"
  | "text.delete"
  | "map.set"
  | "map.delete";

export interface TextInsertOperation {
  kind: "text.insert";
  opId: ElementId;
  deps: VectorClock;
  after: ElementId | "ROOT";
  value: string;
}

export interface TextDeleteOperation {
  kind: "text.delete";
  opId: ElementId;
  deps: VectorClock;
  target: ElementId;
}

export interface MapSetOperation {
  kind: "map.set";
  opId: ElementId;
  deps: VectorClock;
  key: string;
  value: JsonValue;
  logicalTime: number;
}

export interface MapDeleteOperation {
  kind: "map.delete";
  opId: ElementId;
  deps: VectorClock;
  key: string;
  logicalTime: number;
}

export type CrdtOperation =
  | TextInsertOperation
  | TextDeleteOperation
  | MapSetOperation
  | MapDeleteOperation;

export function isTextInsert(op: CrdtOperation): op is TextInsertOperation {
  return op.kind === "text.insert";
}

export function isTextDelete(op: CrdtOperation): op is TextDeleteOperation {
  return op.kind === "text.delete";
}

export function isMapSet(op: CrdtOperation): op is MapSetOperation {
  return op.kind === "map.set";
}

export function isMapDelete(op: CrdtOperation): op is MapDeleteOperation {
  return op.kind === "map.delete";
}

// ---------------------------------------------------------------------------
// RGA node
// ---------------------------------------------------------------------------

export interface RgaNode {
  id: ElementId;
  after: ElementId | "ROOT";
  value: string;
  deleted: boolean;
}

// ---------------------------------------------------------------------------
// LWW map register (per key)
// ---------------------------------------------------------------------------

export interface LwwRegister {
  key: string;
  value: JsonValue;
  deleted: boolean;
  logicalTime: number;
  actorId: ActorId;
  counter: number;
}

// ---------------------------------------------------------------------------
// Materialized state
// ---------------------------------------------------------------------------

export interface MaterializedState {
  text: string;
  map: Map<string, JsonValue>;
  versionVector: VectorClock;
  schemaVersion: number;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface Snapshot {
  schemaVersion: number;
  versionVector: VectorClock;
  nodes: RgaNode[];
  registers: LwwRegister[];
  checksum: string;
}

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

export const CURRENT_SCHEMA_VERSION = 1;

// Reasonable operational limits (docs §4.4, §5.1).
export const CORE_LIMITS = {
  maxActorsInVector: 1000,
  maxCounterGap: 1_000_000,
  maxPendingOps: 10_000,
  maxOpSizeBytes: 64 * 1024,
  maxStringLength: 10_000,
  maxMapKeys: 10_000,
} as const;
