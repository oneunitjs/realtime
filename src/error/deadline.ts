/**
 * Deadline and cancellation helper.
 *
 * docs/error/error-handling.md §5.2: timeouts must abort the underlying work
 * when the platform allows it. Merely racing a promise against a timer does
 * not cancel the work and can leave orphaned operations.
 *
 * `withDeadline` creates a child `AbortController`, links parent cancellation
 * to child cancellation, aborts when the deadline expires, passes the signal
 * to downstream work, and clears timers / detaches listeners in `finally`.
 */

export class DeadlineExceededError extends Error {
  constructor(message = "Deadline exceeded", options?: { cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

export interface DeadlineOptions {
  /** Parent abort signal whose cancellation propagates to the child work. */
  parentSignal?: AbortSignal;
  /** Message used when the deadline expires. */
  timeoutMessage?: string;
}

/**
 * Run `work` with a deadline. The returned `AbortSignal` is passed to
 * downstream calls so disconnects and deadlines actually cancel work.
 *
 * Throws `DeadlineExceededError` when the deadline expires before `work`
 * settles. Timers are cleared and listeners detached in `finally`.
 */
export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  options: DeadlineOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const { parentSignal, timeoutMessage = "Deadline exceeded" } = options;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let parentUnsubscribe: (() => void) | null = null;

  const abort = () => controller.abort();

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (parentUnsubscribe) {
      parentUnsubscribe();
      parentUnsubscribe = null;
    }
  };

  // Link parent cancellation to child cancellation.
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentUnsubscribe = () => parentSignal.removeEventListener("abort", abort);
      parentSignal.addEventListener("abort", abort, { once: true });
    }
  }

  timer = setTimeout(() => {
    controller.abort();
  }, ms);
  timer.unref?.();

  try {
    return await work(controller.signal);
  } catch (error) {
    // Convert deadline/cancellation into a distinct error unless the work
    // itself already surfaced a deadline error. Genuine work failures are
    // re-thrown unchanged.
    if (controller.signal.aborted && !(error instanceof DeadlineExceededError)) {
      throw new DeadlineExceededError(timeoutMessage, { cause: error });
    }
    throw error;
  } finally {
    cleanup();
  }
}
