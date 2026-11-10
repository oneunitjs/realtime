/**
 * Latency benchmarks (gated behind `RUN_PERF=1`).
 *
 * Measures round-trip ping/pong RTT, fan-out latency, and connection
 * handshake latency over the real uWS transport. Reports p50/p95/p99.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createTransportServer, connectRaw, closeAllServers } from "../helpers/transport-factory.js";

afterEach(async () => {
  await closeAllServers();
});

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const frac = rank - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * frac;
}

function pcts(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  return { p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99) };
}

async function authedClient(wsUrl: string, token: string) {
  const client = await connectRaw(wsUrl + `?token=${token}`);
  await client.next(); // welcome
  return client;
}

describe("performance — latency", () => {
  it.skipIf(!process.env.RUN_PERF)(
    "measures ping/pong round-trip latency p50/p95/p99",
    async () => {
      const { server, wsUrl, close } = await createTransportServer({
        authenticate: async (context) => ({
          userId: `user:${String(context.query.token ?? "anon")}`,
          tenantId: "acme",
        }),
      });
      await server.listen();

      const client = await authedClient(wsUrl, "alice");
      client.send({ type: "join", channel: "lobby" });
      await client.next(); // joined

      const samples: number[] = [];
      const iterations = 200;
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        client.send({ type: "ping" });
        await client.next();
        samples.push(performance.now() - start);
      }

      const { p50, p95, p99 } = pcts(samples);
      console.log(`ping/pong RTT ms: p50=${p50.toFixed(2)} p95=${p95.toFixed(2)} p99=${p99.toFixed(2)}`);

      client.close();
      await close();
      expect(p99).toBeLessThan(500);
    },
  );

  it.skipIf(!process.env.RUN_PERF)(
    "measures fan-out latency from publisher to N subscribers",
    async () => {
      const subscriberCount = 20;
      const { server, wsUrl, close } = await createTransportServer({
        authenticate: async (context) => ({
          userId: `user:${String(context.query.token ?? "anon")}`,
          tenantId: "acme",
        }),
      });
      await server.listen();

      const publisher = await authedClient(wsUrl, "publisher");
      publisher.send({ type: "join", channel: "lobby" });
      await publisher.next(); // joined

      const subscribers = [];
      for (let i = 0; i < subscriberCount; i++) {
        const sub = await authedClient(wsUrl, `sub-${i}`);
        sub.send({ type: "join", channel: "lobby" });
        await sub.next(); // joined
        subscribers.push(sub);
      }

      const latencies: number[] = [];
      const rounds = 20;
      for (let r = 0; r < rounds; r++) {
        const start = performance.now();
        publisher.send({ type: "message", channel: "lobby", payload: { r } });
        await Promise.all(subscribers.map((sub) => sub.next()));
        latencies.push(performance.now() - start);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const { p50, p95, p99 } = pcts(latencies);
      console.log(`fan-out latency ms (N=${subscriberCount}): p50=${p50.toFixed(2)} p95=${p95.toFixed(2)} p99=${p99.toFixed(2)}`);

      publisher.close();
      for (const sub of subscribers) sub.close();
      await close();
      expect(p99).toBeLessThan(500);
    },
  );

  it.skipIf(!process.env.RUN_PERF)(
    "measures connection handshake latency connect → welcome",
    async () => {
      const { server, wsUrl, close } = await createTransportServer({
        authenticate: async (context) => ({
          userId: `user:${String(context.query.token ?? "anon")}`,
          tenantId: "acme",
        }),
      });
      await server.listen();

      const samples: number[] = [];
      const iterations = 50;
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        const client = await connectRaw(wsUrl + `?token=h-${i}`);
        await client.next(); // welcome
        samples.push(performance.now() - start);
        client.close();
      }

      const { p50, p95, p99 } = pcts(samples);
      console.log(`handshake latency ms: p50=${p50.toFixed(2)} p95=${p95.toFixed(2)} p99=${p99.toFixed(2)}`);

      await close();
      expect(p99).toBeLessThan(500);
    },
  );
});
