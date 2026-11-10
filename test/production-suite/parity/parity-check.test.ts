/**
 * Environment parity check test.
 *
 * Asserts that `staging.config.ts` remains parity with `production.config.ts`,
 * that uWebSockets.js is the sole WebSocket engine (no broker deps), that the
 * Hub core imports no transport/framework/broker modules, and that protocol
 * version constants are stable integers.
 *
 * Runs in every CI run (not gated behind RUN_PERF).
 */

import { describe, expect, it } from "vitest";
import {
  assertConfigParity,
  assertDependencyBoundaries,
  assertHubCoreBoundaries,
  assertVersionConstants,
} from "../helpers/assert-parity.js";

describe("environment parity", () => {
  it("production and staging configs remain parity field-for-field", () => {
    const result = assertConfigParity();
    expect(result.passed, result.failures.join("\n")).toBe(true);
  });

  it("staging limits are at least as strict as production", () => {
    const result = assertConfigParity();
    const limitFailures = result.failures.filter((f) => f.startsWith("limits."));
    expect(limitFailures).toEqual([]);
  });

  it("uWebSockets.js is the sole WebSocket engine; no broker dependencies", () => {
    const result = assertDependencyBoundaries();
    expect(result.passed, result.failures.join("\n")).toBe(true);
  });

  it("Hub core imports no transport, framework, or broker modules", () => {
    const result = assertHubCoreBoundaries();
    expect(result.passed, result.failures.join("\n")).toBe(true);
  });

  it("protocol version constants are stable integers", () => {
    const result = assertVersionConstants();
    expect(result.passed, result.failures.join("\n")).toBe(true);
    expect(result.protocolVersion).toBeGreaterThanOrEqual(1);
    expect(result.e2eeProtocolVersion).toBeGreaterThanOrEqual(1);
  });
});
