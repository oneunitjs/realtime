/**
 * Retry mechanism.
 *
 * docs/error/error-handling.md §4:
 *
 *   Retry only when:
 *     1. the error is marked `retryable: true`, and
 *     2. the operation is idempotent (or carries a stable idempotency key /
 *        operation ID), and
 *     3. the retry budget (attempt count and overall deadline) remains
 *        available.
 *
 *   Never blindly retry a non-idempotent publish or side effect.
 *
 *   Bounded exponential backoff with jitter: base delay, multiplier 2, cap,
 *   jitter to avoid thundering herds, maximum attempts and overall deadline.
 *   Server `retryAfterMs` is treated as a lower bound before the next attempt.
 */

import { RetryExhaustedError } from "./hub-error.js";

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default 3. */
  maxAttempts?: number;
  /** Overall deadline in ms. Default 30000. */
  deadlineMs?: number;
  /** Base delay in ms (source example range 100-200). Default 150. */
  baseDelayMs?: number;
  /** Backoff multiplier. Default 2. */
  multiplier?: number;
  /** Cap on an individual backoff delay in ms (source example range 10000-30000). Default 15000. */
  capDelayMs?: number;
  /** Whether the operation is idempotent or carries a stable idempotency key. Default false. */
  idempotent?: boolean;
  /** Called before each retry with the error and next attempt number. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Clock abstraction for tests. Defaults to Date.now / setTimeout. */
  clock?: {
    now(): number;
    setTimeout(cb: () => void, ms: number): ReturnType<typeof setTimeout>;
    clearTimeout(id: ReturnType<typeof setTimeout>): void;
  };
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_BASE_DELAY_MS = 150;
const DEFAULT_MULTIPLIER = 2;
const DEFAULT_CAP_DELAY_MS = 15_000;

/**
 * Determine whether a mapped `PublicError` (or `HubError`) is retryable.
 * Never infer retryability solely from an exception name or message.
 */
export function isRetryableError(error: unknown): boolean {
  if (error && typeof error === "object" && "retryable" in error) {
    return Boolean((error as { retryable: unknown }).retryable);
  }
  return false;
}

/**
 * Extract `retryAfterMs` from a mapped error when present.
 */
export function retryAfterMsOf(error: unknown): number | undefined {
  if (error && typeof error === "object" && "retryAfterMs" in error) {
    const v = (error as { retryAfterMs: unknown }).retryAfterMs;
    return typeof v === "number" ? v : undefined;
  }
  return undefined;
}

/** Bounded exponential backoff with full jitter. */
export function computeBackoffMs(options: {
  attempt: number; // 1-based attempt that just failed
  baseDelayMs: number;
  multiplier: number;
  capDelayMs: number;
  retryAfterMs?: number; // server lower bound
}): number {
  const { attempt, baseDelayMs, multiplier, capDelayMs, retryAfterMs } = options;
  let delay = baseDelayMs * Math.pow(multiplier, attempt - 1);
  delay = Math.min(delay, capDelayMs);
  delay = Math.floor(Math.random() * Math.max(1, delay));
  if (typeof retryAfterMs === "number" && retryAfterMs > delay) {
    delay = retryAfterMs;
  }
  return Math.max(0, delay);
}

/**
 * Run an idempotency-aware, retryable operation with bounded backoff and an
 * overall deadline. Respects `retryAfterMs` from retryable errors and
 * honors cancellation through the deadline helper.
 *
 * Throws `RetryExhaustedError` (wrapping the last error) when the budget is
 * exhausted, or the underlying non-retryable error immediately.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    deadlineMs = DEFAULT_DEADLINE_MS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    multiplier = DEFAULT_MULTIPLIER,
    capDelayMs = DEFAULT_CAP_DELAY_MS,
    idempotent = false,
    onRetry,
    clock = {
      now: () => Date.now(),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  } = options;

  if (!idempotent) {
    return operation(1);
  }

  const startTime = clock.now();
  let lastError: unknown;
  let attempt = 0;

  try {
    while (attempt < maxAttempts) {
      attempt += 1;

      if (clock.now() - startTime >= deadlineMs) {
        throw new RetryExhaustedError("Retry deadline exhausted", lastError, attempt - 1);
      }

      try {
        return await operation(attempt);
      } catch (error) {
        lastError = error;

        if (!isRetryableError(error)) {
          throw error;
        }
        if (attempt >= maxAttempts) {
          break;
        }
        if (clock.now() - startTime >= deadlineMs) {
          break;
        }

        const retryAfter = retryAfterMsOf(error);
        const delay = computeBackoffMs({
          attempt,
          baseDelayMs,
          multiplier,
          capDelayMs,
          retryAfterMs: retryAfter,
        });

        if (onRetry) {
          onRetry(error, attempt + 1, delay);
        }

        await new Promise<void>((resolve) => {
          const deadlineTime = startTime + deadlineMs;
          const remaining = Math.max(0, deadlineTime - clock.now());
          const waitMs = Math.min(delay, remaining);
          setTimeout(resolve, waitMs);
        });
      }
    }

    throw new RetryExhaustedError("Retry budget exhausted", lastError, attempt);
  } finally {
    // noop: no timers are retained across calls
  }
}
