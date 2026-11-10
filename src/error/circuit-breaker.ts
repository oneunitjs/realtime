/**
 * Circuit breaker for dependencies (database, broker, Collaboration Engine store).
 *
 * docs/error/error-handling.md §8:
 *
 *   - Closed: requests flow and failures are counted.
 *   - Open: requests fail fast; surface `OVERLOADED` or `DELIVERY_FAILED`
 *     with retryability and a known `retryAfterMs` where possible.
 *   - Half-open: allow controlled probes after cooldown.
 *   - Recovered: close the circuit after successful probes.
 *
 * Configuration: failure threshold/window, open duration, half-open probe
 * count, success threshold. Jitter should be added by callers to avoid
 * synchronized probes. Circuit state and transitions are observable.
 */

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Number of failures within the window that opens the circuit. Default 5. */
  failureThreshold?: number;
  /** Window in ms over which failures are counted. Default 60000. */
  windowMs?: number;
  /** Duration in ms the circuit stays open before half-open. Default 30000. */
  openDurationMs?: number;
  /** Number of half-open probes to allow. Default 1. */
  halfOpenProbes?: number;
  /** Successful probes needed to close the circuit. Default 1. */
  successThreshold?: number;
  /** retryAfterMs surfaced while open. Default 5000. */
  retryAfterMs?: number;
}

export interface CircuitBreakerSnapshot {
  state: CircuitState;
  failures: number;
  windowStart: number;
  nextProbeAt?: number;
}

export class CircuitBreakerError extends Error {
  readonly retryAfterMs: number;
  constructor(message = "Circuit breaker is open", retryAfterMs: number) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
    this.retryAfterMs = retryAfterMs;
  }
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private windowStart = 0;
  private openUntil = 0;
  private probes = 0;
  private successes = 0;

  constructor(
    private readonly options: CircuitBreakerOptions = {},
    private readonly clock: { now(): number } = { now: () => Date.now() },
  ) {
    this.windowStart = this.clock.now();
  }

  /** Whether a request may proceed. Throws CircuitBreakerError when open. */
  allowRequest(): void {
    this.rotateWindow();
    const now = this.clock.now();

    if (this.state === "open") {
      if (now >= this.openUntil) {
        this.transitionTo("half-open");
      } else {
        throw new CircuitBreakerError(
          "Circuit breaker is open",
          this.options.retryAfterMs ?? 5000,
        );
      }
    }

    if (this.state === "half-open") {
      if (this.probes >= (this.options.halfOpenProbes ?? 1)) {
        throw new CircuitBreakerError(
          "Circuit breaker is half-open; probe budget exhausted",
          this.options.retryAfterMs ?? 5000,
        );
      }
      this.probes += 1;
    }
  }

  /** Record a successful request. */
  recordSuccess(): void {
    this.rotateWindow();
    if (this.state === "half-open") {
      this.successes += 1;
      if (this.successes >= (this.options.successThreshold ?? 1)) {
        this.transitionTo("closed");
      }
    }
  }

  /** Record a failed request. */
  recordFailure(): void {
    this.rotateWindow();
    const now = this.clock.now();
    this.failures += 1;

    if (this.state === "half-open") {
      this.transitionTo("open", now + (this.options.openDurationMs ?? 30_000));
      return;
    }

    if (
      this.state === "closed" &&
      this.failures >= (this.options.failureThreshold ?? 5)
    ) {
      this.transitionTo("open", now + (this.options.openDurationMs ?? 30_000));
    }
  }

  /** Current observable snapshot. */
  snapshot(): CircuitBreakerSnapshot {
    this.rotateWindow();
    return {
      state: this.state,
      failures: this.failures,
      windowStart: this.windowStart,
      nextProbeAt:
        this.state === "open"
          ? this.openUntil
          : this.state === "half-open"
            ? this.clock.now()
            : undefined,
    };
  }

  /** Force the circuit open (e.g. after a dependency health check fails). */
  forceOpen(durationMs: number): void {
    this.transitionTo("open", this.clock.now() + durationMs);
  }

  /** Force the circuit closed (e.g. after dependency recovery). */
  forceClosed(): void {
    this.transitionTo("closed");
  }

  private rotateWindow(): void {
    const now = this.clock.now();
    if (now - this.windowStart >= (this.options.windowMs ?? 60_000)) {
      this.windowStart = now;
      this.failures = 0;
    }
  }

  private transitionTo(state: CircuitState, openUntil?: number): void {
    this.state = state;
    if (state === "open") {
      this.openUntil = openUntil ?? this.clock.now() + (this.options.openDurationMs ?? 30_000);
      this.probes = 0;
      this.successes = 0;
    } else if (state === "half-open") {
      this.probes = 0;
      this.successes = 0;
    } else {
      this.failures = 0;
      this.openUntil = 0;
      this.probes = 0;
      this.successes = 0;
    }
  }
}
