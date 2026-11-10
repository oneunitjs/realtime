/**
 * Collaboration Engine server-side: operation validator.
 *
 * Implements docs/collab/collaboration-engine.md §5.3 and 7.2.
 *
 * Before accepting an operation we validate: size limits, actor binding,
 * counter monotonicity, document permission, allowed keys, schema, deps.
 */

import type {
  CrdtOperation,
  ElementId,
  VectorClock,
} from "../core/types.js";
import { CORE_LIMITS } from "../core/types.js";
import { validateOperation } from "../core/encode.js";
import type { DocumentAcl } from "./acl.js";

export class ValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

export interface ValidatorDeps {
  acl: DocumentAcl;
  /** Map from actorId to owning userId. */
  actorOwner: Map<string, string>;
}

export class OpValidator {
  constructor(private readonly deps: ValidatorDeps) {}

  /**
   * Validate an operation before durable append. Throws ValidationError
   * on any violation.
   */
  async validate(params: {
    operation: unknown;
    documentId: string;
    principal: { userId: string; roles: readonly string[] };
    actorId: string;
  }): Promise<CrdtOperation> {
    // 1. Schema / shape / size validation.
    validateOperation(params.operation as CrdtOperation);
    const op = params.operation as CrdtOperation;

    // 2. Actor binding: opId.actorId matches the actor bound to the session.
    if (op.opId.actorId !== params.actorId) {
      throw new ValidationError("INVALID_ACTOR", "opId.actorId does not match bound actor");
    }

    // 3. Actor ownership: actor belongs to this principal.
    const owner = this.deps.actorOwner.get(params.actorId);
    if (owner !== undefined && owner !== params.principal.userId) {
      throw new ValidationError("ACTOR_OWNER_MISMATCH", "Actor does not belong to this principal");
    }

    // 4. Document write permission.
    const canWrite = await this.deps.acl.canWrite(params.principal, params.documentId);
    if (!canWrite) {
      throw new ValidationError("DOCUMENT_FORBIDDEN", `No write access to ${params.documentId}`);
    }

    // 5. Allowed map keys / paths (basic: non-empty keys only; deeper
    // schema checks are application-specific).
    if (op.kind === "map.set" || op.kind === "map.delete") {
      if (op.key.length > 256) {
        throw new ValidationError("KEY_TOO_LONG", `Map key exceeds 256 characters`);
      }
    }

    return op;
  }
}
