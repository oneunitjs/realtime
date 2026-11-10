/**
 * Vector clock module.
 *
 * Implements docs/collab/collaboration-engine.md §8.2 and
 * docs/collab/collaboration-engine-architecture-plan.md §5.2.
 *
 * - Read/update highest contiguous counter per actor.
 * - Test whether an operation's dependency vector is satisfied.
 * - Compare vectors for equality, dominance, missing ranges.
 * - Generate bounded missing-operation requests.
 * - Reject invalid actor IDs, negative counters, impossible future dependencies,
 *   oversized vectors.
 *
 * A dependency is satisfied only when the local replica has the corresponding
 * causal history covered by its version vector.
 */

import type {
  ActorId,
  ElementId,
  VectorClock,
} from "./types.js";
import { CORE_LIMITS } from "./types.js";

/** Validation errors for vector clock operations. */
export class VectorClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/**
 * Validate an actor id. Rejects empty or overly long ids.
 */
export function validateActorId(actorId: unknown): asserts actorId is ActorId {
  if (typeof actorId !== "string" || actorId.length === 0) {
    throw new VectorClockError("Actor id must be a non-empty string");
  }
  if (actorId.length > 256) {
    throw new VectorClockError("Actor id exceeds 256 characters");
  }
}

/**
 * Validate a vector clock structure and its bounds.
 */
export function validateVectorClock(
  vector: unknown,
  options?: { maxActors?: number },
): asserts vector is VectorClock {
  const maxActors = options?.maxActors ?? CORE_LIMITS.maxActorsInVector;
  if (vector === null || typeof vector !== "object" || Array.isArray(vector)) {
    throw new VectorClockError("Vector clock must be an object");
  }
  const keys = Object.keys(vector);
  if (keys.length > maxActors) {
    throw new VectorClockError(
      `Vector clock exceeds ${maxActors} actors`,
    );
  }
  for (const key of keys) {
    validateActorId(key);
    const value = (vector as Record<string, unknown>)[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new VectorClockError(
        `Vector clock counter for ${key} must be a non-negative integer`,
      );
    }
    if (value > CORE_LIMITS.maxCounterGap) {
      throw new VectorClockError(
        `Vector clock counter for ${key} exceeds max counter gap`,
      );
    }
  }
}

/** Empty vector clock. */
export function emptyVectorClock(): VectorClock {
  return {};
}

/** Clone a vector clock. */
export function cloneVectorClock(vector: VectorClock): VectorClock {
  return { ...vector };
}

/**
 * Read the highest contiguous counter observed for an actor (0 if absent).
 */
export function readCounter(vector: VectorClock, actorId: ActorId): number {
  const value = vector[actorId];
  return typeof value === "number" ? value : 0;
}

/**
 * Update the vector clock with a new observation: take the max per actor.
 */
export function updateVectorClock(
  vector: VectorClock,
  updates: VectorClock,
): VectorClock {
  const result = { ...vector };
  for (const [actorId, counter] of Object.entries(updates)) {
    validateActorId(actorId);
    const current = result[actorId] ?? 0;
    if (counter > current) {
      result[actorId] = counter;
    }
  }
  return result;
}

/**
 * Advance the vector clock for a single actor by incrementing its counter.
 * Returns the new counter value.
 */
export function advanceVectorClock(
  vector: VectorClock,
  actorId: ActorId,
): number {
  validateActorId(actorId);
  const next = (vector[actorId] ?? 0) + 1;
  vector[actorId] = next;
  return next;
}

/**
 * Compare two vector clocks for equality.
 */
export function vectorClocksEqual(a: VectorClock, b: VectorClock): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (const key of keysA) {
    if (!(key in b)) return false;
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * Check whether `a` dominates `b`: every actor counter in `b` is <= that in `a`.
 * An actor missing from `a` is treated as 0.
 */
export function dominates(a: VectorClock, b: VectorClock): boolean {
  for (const [actorId, counter] of Object.entries(b)) {
    if ((a[actorId] ?? 0) < counter) {
      return false;
    }
  }
  return true;
}

/**
 * Test whether an operation's dependency vector is satisfied by the local
 * version vector. A dependency is satisfied only when the local replica has
 * the corresponding causal history covered by its version vector.
 */
export function depsSatisfied(
  localVector: VectorClock,
  deps: VectorClock,
): boolean {
  return dominates(localVector, deps);
}

/**
 * Compute missing ranges: for each actor in `deps` whose counter exceeds the
 * local counter, report the missing range (local+1 .. dep counter).
 * Bounded to avoid unbounded requests.
 */
export interface MissingRange {
  actorId: ActorId;
  from: number;
  to: number;
}

/**
 * Generate bounded missing-operation requests from a dependency vector against
 * the local version vector. Returns at most `maxRanges` ranges.
 */
export function missingRanges(
  localVector: VectorClock,
  deps: VectorClock,
  options?: { maxRanges?: number },
): MissingRange[] {
  const maxRanges = options?.maxRanges ?? 64;
  const ranges: MissingRange[] = [];
  for (const [actorId, depCounter] of Object.entries(deps)) {
    validateActorId(actorId);
    const localCounter = localVector[actorId] ?? 0;
    if (depCounter > localCounter) {
      ranges.push({
        actorId,
        from: localCounter + 1,
        to: depCounter,
      });
      if (ranges.length >= maxRanges) {
        break;
      }
    }
  }
  return ranges;
}

/**
 * Reject impossible or future dependencies: an actor counter in `deps` that
 * is greater than the source's known max for that actor, or impossible
 * future dependencies outside allowed bounds.
 */
export function validateDepsAgainstSource(
  sourceVector: VectorClock,
  deps: VectorClock,
): void {
  for (const [actorId, counter] of Object.entries(deps)) {
    validateActorId(actorId);
    const sourceCounter = sourceVector[actorId] ?? 0;
    if (counter > sourceCounter + CORE_LIMITS.maxCounterGap) {
      throw new VectorClockError(
        `Impossible future dependency for actor ${actorId}: ${counter} > source ${sourceCounter}`,
      );
    }
  }
}
