/**
 * Disconnect coordinator.
 *
 * `disconnect` is idempotent and safe to call from many places. Concurrent
 * calls share a single in-flight cleanup promise (single-flight guard). Each
 * cleanup step is independently guarded so one failure does not prevent the
 * remaining steps; errors are collected and reported.
 */
export type CleanupStep = () => Promise<void>;

export interface CleanupReport {
  connectionId: string;
  reason: string | undefined;
  steps: Array<{ name: string; ok: boolean; error?: unknown }>;
  durationMs: number;
}

export class DisconnectCoordinator {
  private readonly inflight = new Map<string, Promise<CleanupReport>>();

  async disconnect(
    connectionId: string,
    reason: string | undefined,
    steps: CleanupStep[]
  ): Promise<CleanupReport> {
    const existing = this.inflight.get(connectionId);
    if (existing) {
      return existing;
    }

    const start = Date.now();
    const promise = this.run(connectionId, reason, steps, start);
    this.inflight.set(connectionId, promise);

    try {
      return await promise;
    } finally {
      this.inflight.delete(connectionId);
    }
  }

  private async run(
    connectionId: string,
    reason: string | undefined,
    steps: CleanupStep[],
    start: number
  ): Promise<CleanupReport> {
    const stepReports: CleanupReport["steps"] = [];
    const errors: unknown[] = [];

    for (const step of steps) {
      const name = step.name;
      try {
        await step();
        stepReports.push({ name, ok: true });
      } catch (error) {
        errors.push(error);
        stepReports.push({ name, ok: false, error });
      }
    }

    return {
      connectionId,
      reason,
      steps: stepReports,
      durationMs: Date.now() - start,
    };
  }

  hasInflight(connectionId: string): boolean {
    return this.inflight.has(connectionId);
  }
}
