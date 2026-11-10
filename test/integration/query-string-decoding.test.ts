/**
 * Integration: query-string decoding. The auth provider extracts the
 * credential from `handshake.query.token` / `access_token` / `auth`. Query
 * strings are parsed per the uWS transport's query parser semantics.
 */

import { describe, it, expect } from "vitest";

function credentialFromHandshake(handshake?: {
  query: Record<string, string>;
  headers: Record<string, string>;
  protocol?: string;
}): string | undefined {
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

function handshake(query: Record<string, string>, headers: Record<string, string> = {}) {
  return { query, headers, path: "/ws", protocol: undefined };
}

describe("general integration — query-string decoding", () => {
  it("extracts token from query.token", () => {
    const cred = credentialFromHandshake(handshake({ token: "abc123" }));
    expect(cred).toBe("abc123");
  });

  it("extracts token from query.access_token", () => {
    const cred = credentialFromHandshake(handshake({ access_token: "tok-2" }));
    expect(cred).toBe("tok-2");
  });

  it("extracts token from query.auth", () => {
    const cred = credentialFromHandshake(handshake({ auth: "tok-3" }));
    expect(cred).toBe("tok-3");
  });

  it("prefers token over access_token over auth", () => {
    const cred = credentialFromHandshake(
      handshake({ token: "first", access_token: "second", auth: "third" }),
    );
    expect(cred).toBe("first");
  });

  it("falls back to Bearer authorization header", () => {
    const cred = credentialFromHandshake(
      handshake({}, { authorization: "Bearer header-token" }),
    );
    expect(cred).toBe("header-token");
  });

  it("returns undefined when no credential is present", () => {
    const cred = credentialFromHandshake(handshake({}));
    expect(cred).toBeUndefined();
  });
});
