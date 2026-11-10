/**
 * Document identity helpers.
 *
 * Implements docs/collab/collaboration-engine.md §12.1 and
 * docs/collab/collaboration-engine-architecture-plan.md §7.3, §9.1.
 *
 * Every collaboration boundary — storage, synchronization, deduplication,
 * vector clocks and fan-out — is scoped to a composite document identity of
 * `{ tenantId, documentId }`. A bare `documentId` is not sufficient: two
 * tenants may legitimately own documents with the same name, and they must
 * never share an operation namespace.
 *
 * Composite keys are JSON-encoded to avoid delimiter collision. A naive
 * `${tenantId}:${documentId}` key is ambiguous when an ID itself contains
 * `:`.
 */

export interface DocumentScope {
  readonly tenantId: string;
  readonly documentId: string;
}

export function validateDocumentScope(
  scope: unknown,
): asserts scope is DocumentScope {
  if (
    scope === null ||
    typeof scope !== "object" ||
    Array.isArray(scope)
  ) {
    throw new Error("Document scope must be an object");
  }
  const s = scope as Record<string, unknown>;
  if (typeof s.tenantId !== "string" || s.tenantId.length === 0) {
    throw new Error("Document scope requires a non-empty tenantId");
  }
  if (typeof s.documentId !== "string" || s.documentId.length === 0) {
    throw new Error("Document scope requires a non-empty documentId");
  }
}

/** Stable composite key for a document scope. */
export function documentScopeKey(scope: DocumentScope): string {
  validateDocumentScope(scope);
  return JSON.stringify([scope.tenantId, scope.documentId]);
}

/** Stable composite key for an operation identity within a scope. */
export function operationKey(actorId: string, counter: number): string {
  if (typeof actorId !== "string" || actorId.length === 0) {
    throw new Error("operationKey requires a non-empty actorId");
  }
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new Error("operationKey requires a safe non-negative counter");
  }
  return JSON.stringify([actorId, counter]);
}

export function parseDocumentScopeKey(key: string): DocumentScope {
  const parsed = JSON.parse(key);
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    throw new Error("Invalid document scope key");
  }
  if (
    typeof parsed[0] !== "string" || parsed[0].length === 0 ||
    typeof parsed[1] !== "string" || parsed[1].length === 0
  ) {
    throw new Error("Invalid document scope key");
  }
  return {
    tenantId: parsed[0],
    documentId: parsed[1],
  };
}
