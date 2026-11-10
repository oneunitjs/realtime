/**
 * Metrics collector for production-suite tests.
 *
 * Implements the injectable `Metrics` sink and records every counter, gauge,
 * and timing the Hub reports. Tests can snapshot `Hub.metricsSnapshot` and
 * assert on connection counts, room/document membership, publish delivery, and
 * cleanup metrics.
 */

import type { Metrics } from "../../../src/core/infrastructure/metrics.js";
import type { Hub } from "../../../src/core/core-hub.js";
import type { HubMetrics } from "../../../src/core/core-hub.js";

interface RecordedIncrement {
  name: string;
  value: number;
  at: number;
}

interface RecordedTiming {
  name: string;
  ms: number;
  at: number;
}

export class MetricsCollector implements Metrics {
  readonly increments: RecordedIncrement[] = [];
  readonly gauges: Array<{ name: string; value: number; at: number }> = [];
  readonly timings: RecordedTiming[] = [];

  increment(name: string, value = 1): void {
    this.increments.push({ name, value, at: Date.now() });
  }

  gauge(name: string, value: number): void {
    this.gauges.push({ name, value, at: Date.now() });
  }

  timing(name: string, ms: number): void {
    this.timings.push({ name, ms, at: Date.now() });
  }

  incrementCount(name: string): number {
    return this.increments.filter((i) => i.name === name).length;
  }

  incrementSum(name: string): number {
    return this.increments.filter((i) => i.name === name).reduce((sum, i) => sum + i.value, 0);
  }

  timingValues(name: string): number[] {
    return this.timings.filter((t) => t.name === name).map((t) => t.ms);
  }

  clear(): void {
    this.increments.length = 0;
    this.gauges.length = 0;
    this.timings.length = 0;
  }
}

/** Capture the Hub's live metrics snapshot. */
export function captureMetrics(hub: Hub): HubMetrics {
  return hub.metricsSnapshot;
}
