/**
 * Environment parity assertions for production-suite tests.
 *
 * Compares `production.config.ts` against `staging.config.ts` field-for-field
 * and asserts dependency/version boundaries so the test environment remains
 * predictive of production. Functions return structured results; the parity
 * test wraps them in vitest `expect`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { productionConfig } from "../config/production.config.js";
import { stagingConfig } from "../config/staging.config.js";
import { PROTOCOL_VERSION } from "../../../src/protocol/index.js";
import { E2EE_PROTOCOL_VERSION } from "../../../src/e2ee/index.js";

const packageRoot = join(fileURLToPath(import.meta.url), "../../../..");

export interface ParityResult {
  passed: boolean;
  failures: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value === null || typeof value !== "object" ? {} : (value as Record<string, unknown>);
}

/** Deep-compare two config objects, returning field paths that differ. */
export function diffConfigs(a: unknown, b: unknown, path = ""): string[] {
  const failures: string[] = [];
  const ra = asRecord(a);
  const rb = asRecord(b);
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);

  for (const key of keys) {
    const full = path ? `${path}.${key}` : key;
    const av = ra[key];
    const bv = rb[key];

    if (av === undefined && bv === undefined) continue;
    if (av === undefined || bv === undefined) {
      failures.push(`${full}: present on only one side`);
      continue;
    }

    if (typeof av === "function" || typeof bv === "function") {
      // Functions are config wiring; they cannot be meaningfully deep-compared.
      // Staging intentionally reuses production's auth/authorize functions.
      // A present-on-only-one-side mismatch is caught above.
      continue;
    }

    if (
      typeof av === "object" &&
      av !== null &&
      typeof bv === "object" &&
      bv !== null &&
      !Array.isArray(av) &&
      !Array.isArray(bv)
    ) {
      failures.push(...diffConfigs(av, bv, full));
      continue;
    }

    if (JSON.stringify(av) !== JSON.stringify(bv)) {
      failures.push(`${full}: differs`);
    }
  }

  return failures;
}

export function assertConfigParity(): ParityResult {
  const prod = productionConfig();
  const stag = stagingConfig();
  const failures: string[] = [];

  // Structural drift: any key present on only one side.
  failures.push(...diffConfigs(prod, stag));

  // host / path / publicUrl must match (port may differ for isolation).
  for (const key of ["host", "path", "publicUrl"] as const) {
    if ((prod as Record<string, unknown>)[key] !== (stag as Record<string, unknown>)[key]) {
      failures.push(`config.${key}: staging must match production`);
    }
  }

  // limits: staging must be at least as strict as production.
  const prodLimits = (prod.limits ?? {}) as Record<string, unknown>;
  const stagLimits = (stag.limits ?? {}) as Record<string, unknown>;
  for (const key of ["maxPayloadBytes", "maxBackpressureBytes", "maxConnections", "authTimeoutMs"] as const) {
    const pv = prodLimits[key] as number | undefined;
    const sv = stagLimits[key] as number | undefined;
    if (typeof pv === "number" && typeof sv === "number" && sv < pv) {
      failures.push(`limits.${key}: staging ${sv} is more lenient than production ${pv}`);
    }
  }

  // authenticate provider must be present in both (or neither).
  if ((prod.authenticate === undefined) !== (stag.authenticate === undefined)) {
    failures.push("config.authenticate: presence mismatch between environments");
  }

  // envelopeService epochs and max bytes must match.
  const prodEnvelope = prod.envelopeService;
  const stagEnvelope = stag.envelopeService;
  if ((prodEnvelope === undefined) !== (stagEnvelope === undefined)) {
    failures.push("config.envelopeService: presence mismatch between environments");
  }

  // roomCapacities must be identical.
  failures.push(
    ...diffConfigs(prod.roomCapacities ?? {}, stag.roomCapacities ?? {}, "roomCapacities"),
  );

  return { passed: failures.length === 0, failures };
}

export interface DependencyResult {
  passed: boolean;
  failures: string[];
  dependencies: string[];
}

/** Assert uWebSockets.js is the sole WebSocket engine; no broker packages. */
export function assertDependencyBoundaries(): DependencyResult {
  const failures: string[] = [];
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  ) as { dependencies: Record<string, string>; devDependencies?: Record<string, string> };
  const allDeps = { ...manifest.dependencies, ...(manifest.devDependencies ?? {}) };

  const deps = Object.keys(allDeps).sort();

  if (!allDeps.uwebsocket) {
    failures.push("dependencies.uwebsocket is missing (must be the sole WS engine)");
  }
  if (allDeps.ws) {
    failures.push("dependencies.ws is present (uwebsocket must be the sole engine)");
  }

  const broker = /kafka|amqp|rabbit|nats|redis|sqs|pubsub|bullmq|ioredis/i;
  const brokerDeps = deps.filter((name) => broker.test(name));
  if (brokerDeps.length > 0) {
    failures.push(`broker packages present in dependencies: ${brokerDeps.join(", ")}`);
  }

  return { passed: failures.length === 0, failures, dependencies: deps };
}

export interface HubBoundaryResult {
  passed: boolean;
  failures: string[];
  imports: string[];
}

/** Assert the Hub core imports no transport/framework/broker modules. */
export function assertHubCoreBoundaries(): HubBoundaryResult {
  const failures: string[] = [];
  const source = readFileSync(join(packageRoot, "src/core/core-hub.ts"), "utf8");
  const pattern = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;
  const imports: string[] = [];
  for (const match of source.matchAll(pattern)) {
    imports.push(match[1]);
  }
  const bare = imports.filter((specifier) => !specifier.startsWith("."));
  const forbidden = /^(uwebsocket|fastify|@fastify|express|koa|ws)$/;
  const broker = /kafka|amqp|rabbit|nats|redis|sqs|pubsub|bullmq|ioredis/i;
  for (const dep of bare) {
    if (forbidden.test(dep)) {
      failures.push(`src/core/core-hub.ts imports forbidden module ${dep}`);
    }
    if (broker.test(dep)) {
      failures.push(`src/core/core-hub.ts imports broker module ${dep}`);
    }
  }

  return { passed: failures.length === 0, failures, imports: bare };
}

export interface VersionResult {
  passed: boolean;
  failures: string[];
  protocolVersion: number;
  e2eeProtocolVersion: number;
}

/** Assert protocol version constants are stable across environments. */
export function assertVersionConstants(): VersionResult {
  const failures: string[] = [];
  if (typeof PROTOCOL_VERSION !== "number" || !Number.isInteger(PROTOCOL_VERSION)) {
    failures.push(`PROTOCOL_VERSION must be an integer, got ${PROTOCOL_VERSION}`);
  }
  if (typeof E2EE_PROTOCOL_VERSION !== "number" || !Number.isInteger(E2EE_PROTOCOL_VERSION)) {
    failures.push(`E2EE_PROTOCOL_VERSION must be an integer, got ${E2EE_PROTOCOL_VERSION}`);
  }
  return {
    passed: failures.length === 0,
    failures,
    protocolVersion: PROTOCOL_VERSION as number,
    e2eeProtocolVersion: E2EE_PROTOCOL_VERSION as number,
  };
}
