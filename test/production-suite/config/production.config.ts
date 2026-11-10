/**
 * Production-like RealtimeConfig for @oneunit/realtime.
 *
 * Mirrors the production deployment configuration. Tests that assert
 * environment parity compare their staging config against this file
 * field-for-field (except ephemeral port/host for test isolation).
 *
 * Values are representative of a production realtime WebSocket service:
 * 64 KiB max frame, 256 KiB backpressure per connection, 2 000 max
 * connections, 5 s auth timeout, E2EE epoch 1 allowed, 64 KiB max envelope.
 */

import type { RealtimeConfig } from "../../../src/public/create-realtime.js";
import { EnvelopeService } from "../../../src/e2ee/index.js";

export const PRODUCTION_PORT = 0; // ephemeral in tests; set explicitly in prod
export const PRODUCTION_HOST = "127.0.0.1";
export const PRODUCTION_PATH = "/ws";

export const productionConfig = (overrides: Partial<RealtimeConfig> = {}): RealtimeConfig => ({
  host: PRODUCTION_HOST,
  port: PRODUCTION_PORT,
  path: PRODUCTION_PATH,
  allowedOrigins: ["https://app.example.com", "https://dashboard.example.com"],
  authenticate: async (context) => {
    const token = context.query.token as string | undefined;
    if (!token) {
      throw new Error("UNAUTHENTICATED: missing token");
    }
    return {
      userId: `user:${token}`,
      tenantId: "acme",
      roles: ["user"],
      sessionId: context.query.sessionId as string | undefined ?? "session",
    };
  },
  authorize: async (action, principal, resourceId, tenantId) => {
    // Tenant isolation: a principal may only act on resources in its own tenant.
    if (tenantId && principal.tenantId !== tenantId) {
      return false;
    }
    return true;
  },
  logger: undefined, // production injects a structured logger; tests use SilentLogger
  envelopeService: new EnvelopeService({
    allowedEpochs: new Set([1]),
    maxEnvelopeBytes: 64 * 1024,
  }),
  roomCapacities: {
    lobby: 500,
    "doc-general": 50,
  },
  transport: {
    engine: "uwebsockets",
    mode: "dedicated",
    path: PRODUCTION_PATH,
    maxPayloadBytes: 64 * 1024,
    maxBackpressureBytes: 256 * 1024,
    allowedOrigins: ["https://app.example.com", "https://dashboard.example.com"],
  },
  auth: {
    allowAnonymous: false,
  },
  limits: {
    maxPayloadBytes: 64 * 1024,
    maxBackpressureBytes: 256 * 1024,
    maxConnections: 2_000,
    authTimeoutMs: 5_000,
  },
  ...overrides,
});
