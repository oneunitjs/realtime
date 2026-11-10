/**
 * Authenticated principal contract for collaboration.
 *
 * Implements docs/collab/collaboration-engine.md §7.2 and
 * docs/collab/collaboration-engine-architecture-plan.md §6.
 *
 * The authenticated principal is server-generated. Clients can send
 * operations, but they cannot decide who owns them. Every operation's
 * `opId.actorId` must equal the principal's `actorId`, and that actor must
 * belong to the principal's tenant.
 *
 * Unlike the Core Hub `Principal`, this type carries `actorId` explicitly so
 * actor-binding validation is expressed in the type contract rather than
 * recovered from socket data.
 */

export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly roles: readonly string[];
  readonly sessionId?: string;
}

/** Request context supplied to an authentication provider. */
export interface AuthenticationContext {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly remoteAddress?: string;
}

/** Authenticate a WebSocket connection and return a trusted principal. */
export type Authenticate = (
  context: AuthenticationContext,
) => Promise<AuthenticatedPrincipal | null>;

export function validatePrincipal(
  principal: unknown,
): asserts principal is AuthenticatedPrincipal {
  if (
    principal === null ||
    typeof principal !== "object" ||
    Array.isArray(principal)
  ) {
    throw new Error("Principal must be an object");
  }
  const p = principal as Record<string, unknown>;
  if (typeof p.userId !== "string" || p.userId.length === 0) {
    throw new Error("Principal requires a non-empty userId");
  }
  if (typeof p.tenantId !== "string" || p.tenantId.length === 0) {
    throw new Error("Principal requires a non-empty tenantId");
  }
  if (typeof p.actorId !== "string" || p.actorId.length === 0) {
    throw new Error("Principal requires a non-empty actorId");
  }
  if (!Array.isArray(p.roles)) {
    throw new Error("Principal roles must be an array");
  }
  for (const role of p.roles) {
    if (typeof role !== "string") {
      throw new Error("Principal roles must be strings");
    }
  }
}
