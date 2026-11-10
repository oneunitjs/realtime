/**
 * Collaboration Engine server-side: ACL.
 *
 * Implements docs/collab/collaboration-engine.md §11 and
 * docs/collab/collaboration-engine-architecture-plan.md §7.1.
 *
 * Room / document membership ≠ document permission. Check document:read and
 * document:write at every required boundary.
 */

export interface ActorInfo {
  userId: string;
  actorId: string;
}

export interface DocumentAcl {
  canRead(principal: { userId: string; roles: readonly string[] }, documentId: string): boolean | Promise<boolean>;
  canWrite(principal: { userId: string; roles: readonly string[] }, documentId: string): boolean | Promise<boolean>;
}

/** Default allow-all ACL for tests; production must supply a real one. */
export class AllowAllAcl implements DocumentAcl {
  async canRead(): Promise<boolean> {
    return true;
  }
  async canWrite(): Promise<boolean> {
    return true;
  }
}
