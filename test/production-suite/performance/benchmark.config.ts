/**
 * Benchmark SLO configuration for the production-suite performance tests.
 *
 * Service level objectives are configurable per environment: `target` is the
 * development/CI ideal, `production` is the production threshold (more lenient).
 * Select the active environment via the `BENCH_ENV` env var (`target` | `production`,
 * defaults to `target`).
 *
 * Mirrors the SLO table in TEST_PLAN.md section 4.1 and the baseline captured
 * in `performance/baseline.json`.
 */

export type BenchEnv = "target" | "production";

interface Slos {
  /** Round-trip ping/pong latency, p50 (ms). */
  roundTripLatencyP50Ms: number;
  /** Round-trip ping/pong latency, p95 (ms). */
  roundTripLatencyP95Ms: number;
  /** Round-trip ping/pong latency, p99 (ms). */
  roundTripLatencyP99Ms: number;
  /** Fan-out latency (1:N, N=100), p95 (ms). */
  fanoutLatencyP95Ms: number;
  /** Publish throughput (msg/s). */
  publishThroughputMsgPerSec: number;
  /** Concurrent connections. */
  concurrentConnections: number;
  /** Memory per connection (KiB). */
  memoryPerConnectionKiB: number;
  /** CPU utilization at 1k connections (%). */
  cpuUtilizationPct: number;
  /** Backpressure drop rate at slow consumer (%). */
  backpressureDropRatePct: number;
  /** Graceful shutdown duration (ms). */
  gracefulShutdownDurationMs: number;
}

const target: Slos = {
  roundTripLatencyP50Ms: 5,
  roundTripLatencyP95Ms: 15,
  roundTripLatencyP99Ms: 30,
  fanoutLatencyP95Ms: 20,
  publishThroughputMsgPerSec: 5_000,
  concurrentConnections: 1_000,
  memoryPerConnectionKiB: 50,
  cpuUtilizationPct: 40,
  backpressureDropRatePct: 1,
  gracefulShutdownDurationMs: 2_000,
};

const production: Slos = {
  roundTripLatencyP50Ms: 10,
  roundTripLatencyP95Ms: 30,
  roundTripLatencyP99Ms: 60,
  fanoutLatencyP95Ms: 50,
  publishThroughputMsgPerSec: 2_000,
  concurrentConnections: 500,
  memoryPerConnectionKiB: 100,
  cpuUtilizationPct: 70,
  backpressureDropRatePct: 5,
  gracefulShutdownDurationMs: 5_000,
};

const envs: Record<BenchEnv, Slos> = { target, production };

export function benchEnv(): BenchEnv {
  const raw = (process.env.BENCH_ENV ?? "target") as BenchEnv;
  return raw in envs ? raw : "target";
}

/** Resolve the active SLO set for the current BENCH_ENV. */
export function slos(): Slos {
  return envs[benchEnv()];
}

/** All SLO entries as [metric, threshold] pairs for reporting. */
export function slosEntries(): Array<[string, number]> {
  const s = slos();
  return [
    ["roundTripLatencyP50Ms", s.roundTripLatencyP50Ms],
    ["roundTripLatencyP95Ms", s.roundTripLatencyP95Ms],
    ["roundTripLatencyP99Ms", s.roundTripLatencyP99Ms],
    ["fanoutLatencyP95Ms", s.fanoutLatencyP95Ms],
    ["publishThroughputMsgPerSec", s.publishThroughputMsgPerSec],
    ["concurrentConnections", s.concurrentConnections],
    ["memoryPerConnectionKiB", s.memoryPerConnectionKiB],
    ["cpuUtilizationPct", s.cpuUtilizationPct],
    ["backpressureDropRatePct", s.backpressureDropRatePct],
    ["gracefulShutdownDurationMs", s.gracefulShutdownDurationMs],
  ];
}

export { target, production };
