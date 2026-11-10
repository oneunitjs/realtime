/**
 * Canonical encoding and operation validation.
 *
 * Implements docs/collab/collaboration-engine.md §5.3, §8 and
 * docs/collab/collaboration-engine-architecture-plan.md §4.2, §5.1.
 *
 * - One canonical wire encoding for all clients and server validators.
 *   The same operation ID with the same canonical payload is a duplicate
 *   and must be idempotent; the same ID with a different payload is a
 *   protocol violation.
 * - Define JsonValue, operation limits, schema versions, and runtime
 *   validators explicitly. Do not rely on TypeScript types for untrusted
 *   network input.
 */

import type {
  CrdtOperation,
  ElementId,
  JsonValue,
  TextDeleteOperation,
  TextInsertOperation,
  VectorClock,
} from "./types.js";
import { CORE_LIMITS, encodeElementId } from "./types.js";
import { validateVectorClock } from "./vector-clock.js";

export class EncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/**
 * Canonical JSON serialization: deterministic key order, no whitespace,
 * stable across runtimes and languages. Used for operation payload hashing
 * and duplicate detection.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    out[key] = canonicalize(obj[key]);
  }
  return out;
}

/**
 * Canonical byte encoding of an operation for hashing / duplicate detection.
 * Deterministic field order.
 */
export function encodeOperation(op: CrdtOperation): Uint8Array {
  const canonical: Record<string, unknown> = {
    kind: op.kind,
    opId: encodeElementId(op.opId),
    deps: canonicalizeVectorClock(op.deps),
  };
  switch (op.kind) {
    case "text.insert":
      canonical.after = op.after === "ROOT" ? "ROOT" : encodeElementId(op.after);
      canonical.value = op.value;
      break;
    case "text.delete":
      canonical.target = encodeElementId(op.target);
      break;
    case "map.set":
      canonical.key = op.key;
      canonical.value = op.value;
      canonical.logicalTime = op.logicalTime;
      break;
    case "map.delete":
      canonical.key = op.key;
      canonical.logicalTime = op.logicalTime;
      break;
  }
  return new TextEncoder().encode(canonicalJson(canonical));
}

function canonicalizeVectorClock(vector: VectorClock): Record<string, number> {
  const out: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const key of Object.keys(vector).sort()) {
    out[key] = vector[key];
  }
  return out;
}


function assertJsonValue(
  value: unknown,
  path = "value",
  seen = new Set<object>(),
  depth = 0,
): asserts value is JsonValue {
  if (depth > 64) throw new EncodeError(`${path} exceeds maximum nesting depth`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new EncodeError(`${path} must contain finite numbers`);
    return;
  }
  if (typeof value !== "object") {
    throw new EncodeError(`${path} must be JSON-compatible`);
  }
  if (seen.has(value)) throw new EncodeError(`${path} must not contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) throw new EncodeError(`${path} must not contain sparse arrays`);
      assertJsonValue(value[i], `${path}[${i}]`, seen, depth + 1);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new EncodeError(`${path} must contain plain objects`);
    }
    for (const [key, child] of Object.entries(value)) {
      assertJsonValue(child, `${path}.${key}`, seen, depth + 1);
    }
  }
  seen.delete(value);
}

/**
 * Validate an operation's shape, schema version, and size limits before it
 * reaches the apply engine. Throws EncodeError on invalid input.
 */
export function validateOperation(op: unknown): asserts op is CrdtOperation {
  if (op === null || typeof op !== "object") {
    throw new EncodeError("Operation must be an object");
  }
  const o = op as Record<string, unknown>;
  const kind = o.kind;
  if (
    kind !== "text.insert" &&
    kind !== "text.delete" &&
    kind !== "map.set" &&
    kind !== "map.delete"
  ) {
    throw new EncodeError(`Invalid or missing op kind: ${kind}`);
  }

  // opId validation.
  const opId = o.opId as { actorId: unknown; counter: unknown } | undefined;
  if (!opId || typeof opId !== "object") {
    throw new EncodeError("opId must be an object");
  }
  if (
    typeof opId.actorId !== "string" ||
    opId.actorId.length === 0 ||
    opId.actorId.length > 256 ||
    opId.actorId.includes("\0")
  ) {
    throw new EncodeError("opId.actorId must be a non-empty string");
  }
  if (
    typeof opId.counter !== "number" ||
    !Number.isSafeInteger(opId.counter) ||
    opId.counter < 0
  ) {
    throw new EncodeError("opId.counter must be a non-negative integer");
  }

  // deps validation.
  validateVectorClock(o.deps, { maxActors: CORE_LIMITS.maxActorsInVector });

  switch (kind) {
    case "text.insert": {
      const insert = op as TextInsertOperation;
      if (
        insert.after !== "ROOT" &&
        (insert.after === null ||
          typeof insert.after !== "object" ||
          typeof insert.after.actorId !== "string" ||
          insert.after.actorId.length === 0 ||
          insert.after.actorId.length > 256 ||
          insert.after.actorId.includes("\0") ||
          !Number.isSafeInteger(insert.after.counter) ||
          insert.after.counter < 0)
      ) {
        throw new EncodeError("text.insert after must be an ElementId or ROOT");
      }
      if (
        typeof insert.value !== "string" ||
        Array.from(insert.value).length !== 1
      ) {
        throw new EncodeError("text.insert value must be a single Unicode scalar");
      }
      break;
    }
    case "text.delete": {
      const del = op as TextDeleteOperation;
      if (
        del.target === null ||
        typeof del.target !== "object" ||
        typeof del.target.actorId !== "string" ||
        del.target.actorId.length === 0 ||
        del.target.actorId.length > 256 ||
        del.target.actorId.includes("\0") ||
        !Number.isSafeInteger(del.target.counter) ||
        del.target.counter < 0
      ) {
        throw new EncodeError("text.delete target must be an ElementId");
      }
      break;
    }
    case "map.set": {
      const set = op as TextInsertOperation as unknown as {
        key: string;
        value: JsonValue;
        logicalTime: number;
      };
      if (typeof set.key !== "string" || set.key.length === 0) {
        throw new EncodeError("map.set key must be a non-empty string");
      }
      assertJsonValue(set.value, "map.set value");
      if (
        typeof set.logicalTime !== "number" ||
        !Number.isSafeInteger(set.logicalTime) ||
        set.logicalTime < 0
      ) {
        throw new EncodeError("map.set logicalTime must be a non-negative integer");
      }
      break;
    }
    case "map.delete": {
      const del = op as TextDeleteOperation as unknown as {
        key: string;
        logicalTime: number;
      };
      if (typeof del.key !== "string" || del.key.length === 0) {
        throw new EncodeError("map.delete key must be a non-empty string");
      }
      if (
        typeof del.logicalTime !== "number" ||
        !Number.isSafeInteger(del.logicalTime) ||
        del.logicalTime < 0
      ) {
        throw new EncodeError("map.delete logicalTime must be a non-negative integer");
      }
      break;
    }
  }

  // Size validation runs after shape checks so malformed nested values fail
  // with a controlled validation error rather than a property-access crash.
  try {
    const encoded = encodeOperation(op as CrdtOperation);
    if (encoded.byteLength > CORE_LIMITS.maxOpSizeBytes) {
      throw new EncodeError(
        `Operation exceeds max size ${CORE_LIMITS.maxOpSizeBytes} bytes`,
      );
    }
  } catch (error) {
    if (error instanceof EncodeError) throw error;
    throw new EncodeError("Operation contains a value that cannot be encoded");
  }
}

/**
 * Validate schema version compatibility. Reject unknown/unsupported versions
 * (never silently reinterpret).
 */
export function validateSchemaVersion(version: unknown): number {
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new EncodeError("schemaVersion must be an integer");
  }
  if (version !== 1) {
    throw new EncodeError(`Unsupported schema version: ${version}`);
  }
  return version;
}
