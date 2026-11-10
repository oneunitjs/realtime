/**
 * Robustness — error contract.
 *
 * Verifies `PublicError` is allowlisted (no stack/secrets), registry mapping
 * preserves codes/retryability, unknown exceptions map to `INTERNAL`, and
 * the serializer emits only safe public fields.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  mapError,
  toPublicError,
  serializePublicError,
  HubError,
  OverloadedError,
  ValidationFailedError,
  DeadlineExceededError,
  RetryExhaustedError,
} from "../../../src/error/index.js";
import { CircuitBreaker } from "../../../src/error/circuit-breaker.js";

afterEach(() => {
  // no-op
});

describe("robustness — error contract", () => {
  it("mapError emits an allowlisted PublicError with no stack/secrets", () => {
    const error = mapError(new ValidationFailedError("raw leaky detail"));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.message).toBe("Request validation failed."); // registry default, not raw
    expect(error.retryable).toBe(false);
    expect(error.requestId).toBeDefined();
    expect(typeof error.requestId).toBe("string");
    // Serialized form contains only allowlisted keys.
    const serialized = serializePublicError(error);
    expect(new Set(Object.keys(serialized))).toEqual(new Set([
      "code",
      "message",
      "retryable",
      "requestId",
    ]));
  });

  it("mapError preserves retryable and retryAfterMs for retryable errors", () => {
    const error = mapError(new OverloadedError("busy", { retryAfterMs: 1000 }));
    expect(error.code).toBe("OVERLOADED");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(1000);
    const serialized = serializePublicError(error);
    expect(serialized.retryAfterMs).toBe(1000);
  });

  it("mapError maps unknown exceptions to INTERNAL with an opaque message", () => {
    const error = mapError(new TypeError("internal boom"));
    expect(error.code).toBe("INTERNAL");
    expect(error.message).toBe("An internal error occurred.");
    expect(error.retryable).toBe(false);
  });

  it("toPublicError emits only allowlisted fields", () => {
    const publicError = toPublicError("FORBIDDEN", "Not authorized.", false, {
      requestId: "req-1",
      retryAfterMs: 500,
    });
    expect(publicError.code).toBe("FORBIDDEN");
    expect(publicError.message).toBe("Not authorized.");
    expect(publicError.retryable).toBe(false);
    expect(publicError.requestId).toBe("req-1");
    expect(publicError.retryAfterMs).toBe(500);
    expect(new Set(Object.keys(publicError))).toEqual(new Set([
      "code",
      "message",
      "retryAfterMs",
      "retryable",
      "requestId",
    ]));
  });

  it("serializePublicError never emits stack or secrets", () => {
    const publicError = mapError(new HubError("INTERNAL", "raw secret", {
      details: { token: "secret" },
    }));
    const serialized = serializePublicError(publicError);
    const json = JSON.stringify(serialized);
    expect(json).not.toContain("secret");
    expect(json).not.toContain("stack");
    expect(json).not.toContain("cause");
  });

  it("RetryExhaustedError maps to RETRY_EXHAUSTED and is not retryable", () => {
    const error = mapError(new RetryExhaustedError("exhausted", new Error("boom"), 3));
    expect(error.code).toBe("RETRY_EXHAUSTED");
    expect(error.retryable).toBe(false);
    expect(error.message).toBe("Retry budget exhausted.");
  });

  it("DeadlineExceededError maps to INTERNAL (not registered in the registry)", () => {
    const error = mapError(new DeadlineExceededError("too slow"));
    expect(error.code).toBe("INTERNAL");
    expect(error.retryable).toBe(false);
  });

  it("circuit breaker transitions closed → open on threshold", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, openDurationMs: 10 });
    cb.allowRequest();
    cb.recordFailure();
    cb.allowRequest();
    cb.recordFailure();
    expect(cb.snapshot().state).toBe("open");
    expect(() => cb.allowRequest()).toThrow();
  });
});
