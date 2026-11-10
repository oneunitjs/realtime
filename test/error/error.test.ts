import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HubError,
  mapError,
  toPublicError,
  serializePublicError,
  globalRegistry,
  UnauthenticatedError,
  ForbiddenError,
  ValidationFailedError,
  MessageTooLargeError,
  VersionUnsupportedError,
  RateLimitedError,
  ConnectionLimitError,
  RoomFullError,
  OverloadedError,
  RoomNotFoundError,
  NamespaceNotFoundError,
  DocumentNotFoundError,
  ConnectionClosedError,
  EventTimeoutError,
  DeliveryFailedError,
  DocumentForbiddenError,
  CrdtInvalidOperationError,
  withDeadline,
  DeadlineExceededError,
  withRetry,
  isRetryableError,
  retryAfterMsOf,
  computeBackoffMs,
  CircuitBreaker,
  CircuitBreakerError,
} from "../../src/error/index.js";
import type { ErrorCode } from "../../src/error/index.js";
import { RetryExhaustedError } from "../../src/error/index.js";

// ---------------------------------------------------------------------------
// Registry mapping for every internal error class
// (docs/error/error-handling.md §12)
// ---------------------------------------------------------------------------

describe("error contract — registry mapping", () => {
  const cases: Array<[new (...args: any[]) => Error, ErrorCode]> = [
    [UnauthenticatedError, "UNAUTHENTICATED"],
    [ForbiddenError, "FORBIDDEN"],
    [ValidationFailedError, "VALIDATION_FAILED"],
    [MessageTooLargeError, "MESSAGE_TOO_LARGE"],
    [VersionUnsupportedError, "VERSION_UNSUPPORTED"],
    [RateLimitedError, "RATE_LIMITED"],
    [ConnectionLimitError, "CONNECTION_LIMIT"],
    [RoomFullError, "ROOM_FULL"],
    [OverloadedError, "OVERLOADED"],
    [RoomNotFoundError, "ROOM_NOT_FOUND"],
    [NamespaceNotFoundError, "NAMESPACE_NOT_FOUND"],
    [DocumentNotFoundError, "DOCUMENT_NOT_FOUND"],
    [ConnectionClosedError, "CONNECTION_CLOSED"],
    [EventTimeoutError, "EVENT_TIMEOUT"],
    [DeliveryFailedError, "DELIVERY_FAILED"],
    [DocumentForbiddenError, "DOCUMENT_FORBIDDEN"],
    [CrdtInvalidOperationError, "CRDT_INVALID_OPERATION"],
  ];

  it("maps every registered subclass to its public code via mapError", () => {
    for (const [ErrorClass, code] of cases) {
      const err = new ErrorClass("boom");
      const publicError = mapError(err, { requestId: "req-1" });
      expect(publicError.code).toBe(code);
      expect(publicError.requestId).toBe("req-1");
    }
  });

  it("each subclass has exactly one registry mapping", () => {
    const seen = new Set<ErrorCode>();
    for (const [ErrorClass, code] of cases) {
      const instance = new ErrorClass("x");
      const entry = globalRegistry.lookup(instance);
      expect(entry.code).toBe(code);
      expect(seen.has(code)).toBe(false);
      seen.add(code);
    }
  });

  it("RetryExhaustedError maps to RETRY_EXHAUSTED", () => {
    const err = new RetryExhaustedError("exhausted", new Error("last"), 3);
    const publicError = mapError(err, { requestId: "req-re" });
    expect(publicError.code).toBe("RETRY_EXHAUSTED");
    expect(publicError.requestId).toBe("req-re");
  });

  it("unknown exceptions map to opaque INTERNAL with a request id", () => {
    const publicError = mapError(new Error("raw internal failure"), {
      requestId: "req-42",
    });
    expect(publicError.code).toBe("INTERNAL");
    expect(publicError.message).toBe("An internal error occurred.");
    expect(publicError.retryable).toBe(false);
    expect(publicError.requestId).toBe("req-42");
    expect(JSON.stringify(publicError)).not.toContain("stack");
    expect(JSON.stringify(publicError)).not.toContain("raw internal failure");
  });

  it("unknown non-Error values map to INTERNAL", () => {
    const publicError = mapError("a string error", { requestId: "req-7" });
    expect(publicError.code).toBe("INTERNAL");
    expect(publicError.requestId).toBe("req-7");
  });
});

describe("error contract — serializer allowlist and redaction", () => {
  it("serializes only the allowlisted public fields", () => {
    const err = new RateLimitedError("slow down", { retryAfterMs: 2500 });
    const publicError = mapError(err, { requestId: "req-9" });
    const serialized = serializePublicError(publicError);

    expect(Object.keys(serialized).sort()).toEqual(
      ["code", "message", "retryAfterMs", "retryable", "requestId"].sort(),
    );
    expect(serialized.code).toBe("RATE_LIMITED");
    expect(serialized.retryable).toBe(true);
    expect(serialized.retryAfterMs).toBe(2500);
    expect(serialized.requestId).toBe("req-9");
  });

  it("does not serialize raw details, stack, or secrets", () => {
    const secret = "SECRET-SENTINEL-KEY-12345";
    const err = new ValidationFailedError("bad input", {
      details: { secret, raw: "internal path" },
    });
    (err as Error & { stack?: string }).stack =
      "Error: bad input\n    at " + secret;

    const publicError = mapError(err, { requestId: "req-redact" });
    const serialized = serializePublicError(publicError);
    const json = JSON.stringify(serialized);

    expect(json).not.toContain(secret);
    expect(json).not.toContain("internal path");
    expect(json).not.toContain("stack");
    expect(serialized.message).toBe("Request validation failed.");
  });

  it("retryAfterMs is present only when retryable and known", () => {
    const retryable = mapError(new OverloadedError("busy", { retryAfterMs: 4000 }), {
      requestId: "r1",
    });
    expect(retryable.retryAfterMs).toBe(4000);
    expect(retryable.retryable).toBe(true);

    const nonRetryable = mapError(new ForbiddenError("nope"), { requestId: "r2" });
    expect(nonRetryable.retryAfterMs).toBeUndefined();
    expect(nonRetryable.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Deadline / cancellation
// (docs/error/error-handling.md §5.2, §12)
// ---------------------------------------------------------------------------

describe("error contract — withDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts work when the deadline expires", async () => {
    const promise = withDeadline(
      async (signal) => {
        await new Promise((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
        if (signal.aborted) {
          throw new Error("work observed abort");
        }
        return "done";
      },
      100,
    );

    vi.advanceTimersByTime(150);
    await expect(promise).rejects.toBeInstanceOf(DeadlineExceededError);
  });

  it("resolves normally when work settles before the deadline", async () => {
    const result = await withDeadline(async (signal) => {
      expect(signal.aborted).toBe(false);
      return "ok";
    }, 1000);
    expect(result).toBe("ok");
  });

  it("re-throws genuine work failures unchanged", async () => {
    const promise = withDeadline(
      async () => {
        throw new ValidationFailedError("bad input");
      },
      1000,
    );
    await expect(promise).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it("propagates parent cancellation to child work", async () => {
    const parent = new AbortController();
    const promise = withDeadline(
      async (signal) => {
        await new Promise((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
        throw new Error("work observed abort");
      },
      10_000,
      { parentSignal: parent.signal },
    );

    parent.abort();
    await expect(promise).rejects.toBeInstanceOf(DeadlineExceededError);
  });
});

// ---------------------------------------------------------------------------
// Retry eligibility, backoff, and exhaustion
// (docs/error/error-handling.md §4, §12)
// ---------------------------------------------------------------------------

describe("error contract — retry eligibility gate", () => {
  it("retries retryable idempotent operations within budget", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new DeliveryFailedError("transient");
        }
        return "success";
      },
      { idempotent: true, maxAttempts: 5, baseDelayMs: 1, capDelayMs: 10 },
    );
    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  it("does not retry non-idempotent operations", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new DeliveryFailedError("transient");
        },
        { idempotent: false, maxAttempts: 5, baseDelayMs: 1, capDelayMs: 10 },
      ),
    ).rejects.toBeInstanceOf(DeliveryFailedError);
    expect(attempts).toBe(1);
  });

  it("does not retry non-retryable errors", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new ValidationFailedError("bad");
        },
        { idempotent: true, maxAttempts: 5, baseDelayMs: 1, capDelayMs: 10 },
      ),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    expect(attempts).toBe(1);
  });

  it("exhausts the budget and throws RetryExhaustedError", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new DeliveryFailedError("always fails");
        },
        {
          idempotent: true,
          maxAttempts: 2,
          baseDelayMs: 1,
          capDelayMs: 10,
          deadlineMs: 1000,
        },
      ),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(attempts).toBe(2);
  });

  it("respects the overall deadline", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new DeliveryFailedError("always fails");
        },
        {
          idempotent: true,
          maxAttempts: 100,
          baseDelayMs: 1,
          capDelayMs: 1,
          deadlineMs: 20,
        },
      ),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(attempts).toBeGreaterThanOrEqual(1);
  });
});

describe("error contract — backoff bounds and jitter", () => {
  it("keeps every backoff within the configured cap", () => {
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 10; attempt++) {
      delays.push(
        computeBackoffMs({
          attempt,
          baseDelayMs: 100,
          multiplier: 2,
          capDelayMs: 1000,
        }),
      );
    }
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1000);
    }
  });

  it("honors retryAfterMs as a lower bound", () => {
    const delay = computeBackoffMs({
      attempt: 1,
      baseDelayMs: 10,
      multiplier: 2,
      capDelayMs: 100,
      retryAfterMs: 500,
    });
    expect(delay).toBeGreaterThanOrEqual(500);
  });
});

describe("error contract — retryable helpers", () => {
  it("isRetryableError reflects the registry flag", () => {
    expect(isRetryableError(new RateLimitedError("x"))).toBe(true);
    expect(isRetryableError(new OverloadedError("x"))).toBe(true);
    expect(isRetryableError(new DeliveryFailedError("x"))).toBe(true);
    expect(isRetryableError(new ValidationFailedError("x"))).toBe(false);
    expect(isRetryableError(new ForbiddenError("x"))).toBe(false);
    expect(isRetryableError(new Error("x"))).toBe(false);
  });

  it("retryAfterMsOf extracts the delay when present", () => {
    expect(
      retryAfterMsOf(new RateLimitedError("x", { retryAfterMs: 3000 })),
    ).toBe(3000);
    expect(
      retryAfterMsOf(new OverloadedError("x", { retryAfterMs: 1000 })),
    ).toBe(1000);
    expect(retryAfterMsOf(new ValidationFailedError("x"))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker state transitions
// (docs/error/error-handling.md §8, §12)
// ---------------------------------------------------------------------------

describe("error contract — circuit breaker", () => {
  it("starts closed and allows requests", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    expect(cb.snapshot().state).toBe("closed");
    cb.allowRequest();
    cb.recordSuccess();
    expect(cb.snapshot().state).toBe("closed");
  });

  it("opens after the failure threshold within the window", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, windowMs: 60_000 });
    cb.allowRequest();
    cb.recordFailure();
    cb.allowRequest();
    cb.recordFailure();
    expect(cb.snapshot().state).toBe("open");
    expect(() => cb.allowRequest()).toThrow(CircuitBreakerError);
  });

  it("fails fast while open with retryable error and retryAfterMs", () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      openDurationMs: 5_000,
      retryAfterMs: 3_000,
    });
    cb.allowRequest();
    cb.recordFailure();
    let caught: unknown = null;
    try {
      cb.allowRequest();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CircuitBreakerError);
    expect((caught as CircuitBreakerError).retryAfterMs).toBe(3_000);
  });

  it("half-opens after cooldown and recovers on success", () => {
    const clock = { now: () => 0 };
    const cb = new CircuitBreaker(
      {
        failureThreshold: 1,
        openDurationMs: 1,
        halfOpenProbes: 1,
        successThreshold: 1,
      },
      clock,
    );
    cb.allowRequest();
    cb.recordFailure();
    expect(cb.snapshot().state).toBe("open");
    (clock as { now: () => number }).now = () => 10_000;
    cb.allowRequest(); // half-open probe
    expect(cb.snapshot().state).toBe("half-open");
    cb.recordSuccess();
    expect(cb.snapshot().state).toBe("closed");
  });

  it("reopens on a failed half-open probe", () => {
    const clock = { now: () => 0 };
    const cb = new CircuitBreaker(
      {
        failureThreshold: 1,
        openDurationMs: 1,
        halfOpenProbes: 1,
      },
      clock,
    );
    cb.allowRequest();
    cb.recordFailure();
    expect(cb.snapshot().state).toBe("open");
    (clock as { now: () => number }).now = () => 10_000;
    cb.allowRequest(); // half-open probe
    cb.recordFailure();
    expect(cb.snapshot().state).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// Core Hub integration — toPublicError
// ---------------------------------------------------------------------------

describe("error contract — Core Hub toPublicError integration", () => {
  it("maps a Core Hub internal error to a public code", async () => {
    const { Hub } = await import("../../src/core/core-hub.js");
    const hub = new Hub({
      authProvider: {
        authenticate: async () => {
          throw new Error("no");
        },
      },
    });

    const { RoomCapacityError } = await import(
      "../../src/error/index.js"
    );
    const mapped = hub.toPublicError(new RoomCapacityError("full", 1, "room-1"), {
      requestId: "req-hub",
    });
    expect(mapped.code).toBe("ROOM_FULL");
    expect(mapped.requestId).toBe("req-hub");
    expect(mapped.retryable).toBe(false);
    const json = JSON.stringify(mapped);
    // The room id / raw internal context must not leak into the client payload.
    expect(json).not.toContain("room-1");
    expect(json).not.toContain("details");
  });
});
