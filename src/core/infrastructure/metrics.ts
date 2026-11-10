/**
 * Injectable metrics sink. The Hub reports counters but never depends on a
 * concrete monitoring backend.
 */
export interface Metrics {
  increment(name: string, value?: number): void;
  gauge(name: string, value: number): void;
  timing(name: string, ms: number): void;
}

export class SilentMetrics implements Metrics {
  increment(): void {}
  gauge(): void {}
  timing(): void {}
}
