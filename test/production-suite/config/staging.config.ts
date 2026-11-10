/**
 * Staging RealtimeConfig that must remain parity with production.config.ts.
 *
 * Staging mirrors production field-for-field. The only permitted deviations
 * are ephemeral values required for test isolation (port = 0, host = 127.0.0.1)
 * and limits that are at least as strict as production (staging may be stricter
 * but never more lenient).
 *
 * Any new field added to productionConfig must be added here, and
 * parity/parity-check.test.ts asserts the correspondence.
 */

import type { RealtimeConfig } from "../../../src/public/create-realtime.js";
import { EnvelopeService } from "../../../src/e2ee/index.js";
import { productionConfig } from "./production.config.js";

export const STAGING_HOST = "127.0.0.1";
export const STAGING_PATH = "/ws";

export const stagingConfig = (overrides: Partial<RealtimeConfig> = {}): RealtimeConfig => ({
  host: STAGING_HOST,
  port: 0, // ephemeral port for test isolation
  path: STAGING_PATH,
  allowedOrigins: ["https://app.example.com", "https://dashboard.example.com"],
  authenticate: productionConfig().authenticate,
  authorize: productionConfig().authorize,
  logger: undefined,
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
    path: STAGING_PATH,
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
