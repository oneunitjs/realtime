/**
 * Authentication provider contract.
 *
 * The Hub creates the trusted `Principal` only from the verified credential
 * returned here. Client payloads are never trusted as identity claims.
 */
import type { HandshakeContext, Principal } from "../connection/connection.types.js";

export interface AuthContext {
  signal: AbortSignal;
  handshake?: HandshakeContext;
}

export interface AuthProvider {
  authenticate(
    credential: string | undefined,
    options: AuthContext
  ): Promise<Principal>;
}

/** Accept anyone. Intended for local development and tests. */
export const anonymousAuthProvider: AuthProvider = {
  authenticate: async (credential) => ({
    userId: credential && credential.length > 0 ? credential : "anonymous",
    tenantId: "default",
    roles: ["user"],
    sessionId: credential && credential.length > 0 ? credential : "anonymous",
  }),
};

export function credentialFromHandshake(handshake?: HandshakeContext): string | undefined {
  if (!handshake) {
    return undefined;
  }
  const query = handshake.query;
  const fromQuery = query.token ?? query.access_token ?? query.auth;
  if (fromQuery && fromQuery.length > 0) {
    return fromQuery;
  }
  const header = handshake.headers.authorization ?? handshake.headers.Authorization;
  if (header && header.length > 0) {
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? match[1] : header;
  }
  return handshake.protocol && handshake.protocol.length > 0 ? handshake.protocol : undefined;
}
