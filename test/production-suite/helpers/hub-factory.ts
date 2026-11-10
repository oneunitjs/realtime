/**
 * Hub factory for production-suite tests.
 *
 * Builds Hub instances wired with a configurable auth provider, authorize
 * hook, envelope service, clock, id generator, logger, and metrics sink.
 * Returns the Hub plus a teardown helper that closes it.
 */

import { Hub, type HubOptions } from "../../../src/core/core-hub.js";
import type { AuthProvider } from "../../../src/core/auth/auth-provider.js";
import type { Principal } from "../../../src/core/connection/connection.types.js";
import type { Clock } from "../../../src/core/infrastructure/clock.js";
import type { IdGenerator } from "../../../src/core/infrastructure/id-generator.js";
import type { Metrics } from "../../../src/core/infrastructure/metrics.js";
import type { Logger } from "../../../src/error/logger.js";
import type { EnvelopeService } from "../../../src/e2ee/envelope.js";

export function principalFor(userId: string, tenantId: string): Principal {
  return { userId, tenantId, roles: ["user"], sessionId: "s1" };
}

export function makeAuthProvider(options: {
  principal?: Principal;
  delayMs?: number;
  shouldFail?: boolean;
  byCredential?: Record<string, Principal>;
  throwAfterMs?: number;
} = {}): AuthProvider {
  return {
    authenticate: async (credential, { signal }) => {
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      signal.throwIfAborted?.();
      if (options.throwAfterMs) {
        const t = setTimeout(
          () => signal.throwIfAborted?.(),
          options.throwAfterMs,
        );
        try {
          // no-op; we just want the timeout to fire if signal not aborted
        } finally {
          clearTimeout(t);
        }
      }
      if (options.shouldFail) {
        throw new Error("invalid credentials");
      }
      if (options.byCredential && credential) {
        const p = options.byCredential[credential];
        if (p) return p;
        throw new Error("unknown credential");
      }
      return options.principal ?? principalFor("alice", "tenant-a");
    },
  };
}

export interface HubFactoryOptions {
  authProvider?: AuthProvider;
  config?: Partial<import("../../../src/core/connection/connection.types.js").HubConfig>;
  roomCapacities?: Record<string, number>;
  authorize?: HubOptions["authorize"];
  envelopeService?: EnvelopeService;
  clock?: Clock;
  idGenerator?: IdGenerator;
  logger?: Logger;
  metrics?: Metrics;
}

export function createTestHub(options: HubFactoryOptions = {}): Hub {
  return new Hub({
    authProvider: options.authProvider ?? makeAuthProvider(),
    config: options.config,
    roomCapacities: options.roomCapacities,
    authorize: options.authorize,
    envelopeService: options.envelopeService,
    clock: options.clock,
    idGenerator: options.idGenerator,
    logger: options.logger,
    metrics: options.metrics,
  } as HubOptions);
}

export interface HubWithTeardown {
  hub: Hub;
  close: () => Promise<void>;
}

export function createTestHubWithTeardown(
  options: HubFactoryOptions = {},
): HubWithTeardown {
  const hub = createTestHub(options);
  return {
    hub,
    close: async () => {
      await hub.close();
    },
  };
}

export async function connectClient(
  hub: Hub,
  id: string,
  credential = `cred-${id}`,
): Promise<import("../../../src/transport/testing/transport-connection.js").FakeTransport> {
  const transport = new (await import("../../../src/transport/testing/transport-connection.js")).FakeTransport(id);
  await hub.connect(transport, credential);
  return transport;
}
