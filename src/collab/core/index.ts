/**
 * Collaboration Engine CRDT core — pure, transport- and persistence-independent.
 *
 * Implements docs/collab/collaboration-engine.md §5-8 and
 * docs/collab/collaboration-engine-architecture-plan.md §5.
 *
 * Build pure core tests before networking. Networking should not be used to
 * conceal or compensate for an unproven merge algorithm.
 */

export type {
  ActorId,
  ElementId,
  VectorClock,
  CrdtOperation,
  CrdtOperationKind,
  TextInsertOperation,
  TextDeleteOperation,
  MapSetOperation,
  MapDeleteOperation,
  RgaNode,
  LwwRegister,
  MaterializedState,
  Snapshot,
  JsonValue,
} from "./types.js";
import {
  CURRENT_SCHEMA_VERSION,
  CORE_LIMITS,
  encodeElementId,
  decodeElementId,
  compareElementId,
  elementIdEquals,
} from "./types.js";
export {
  CURRENT_SCHEMA_VERSION,
  CORE_LIMITS,
  encodeElementId,
  decodeElementId,
  compareElementId,
  elementIdEquals,
};
export type { EncodeError } from "./encode.js";
export {
  canonicalJson,
  encodeOperation,
  validateOperation,
  validateSchemaVersion,
} from "./encode.js";
export type { VectorClockError } from "./vector-clock.js";
export {
  validateActorId,
  validateVectorClock,
  emptyVectorClock,
  cloneVectorClock,
  readCounter,
  updateVectorClock,
  advanceVectorClock,
  vectorClocksEqual,
  dominates,
  depsSatisfied,
  missingRanges,
  validateDepsAgainstSource,
} from "./vector-clock.js";
export type { RgaOptions } from "./rga.js";
export { RgaError, RgaSequence } from "./rga.js";
export type { LwwMapOptions } from "./map-lww.js";
export { LwwMapError, LwwMap, compareLwwOrder, lwwOrderKey } from "./map-lww.js";
export type { ApplyEngineOptions, ApplyResult } from "./apply.js";
export { ApplyEngineError, ApplyEngine } from "./apply.js";
