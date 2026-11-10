/**
 * Resource-utilization benchmarks (gated behind `RUN_PERF=1`).
 *
 * Measures memory per connection, CPU under load, fan-out backpressure
 * isolation, and max payload enforcement.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createTransportServer, connectRaw, closeAllServers } from "../helpers/transport-factory.js";
import { Hub } from "../../../src/core/core-hub.js";
import { FakeTransport } from "../../../src/transport/testing/transport-connection.js";
import { makeAuthProvider } from "../helpers/hub-factory.js";
import { slowSendTransport } from "../helpers/chaos.js";

afterEach(async () => {
  await closeAllServers();
});

async function authedClient(wsUrl: string, token: string) {
  const client = await connectRaw(wsUrl + `?token=${token}`);
  await client.next(); // welcome
  return client;
}

describe("performance — resource", () => {
  it.skipIf(!process.env.RUN_PERF)(
    "memory per connection stays below the SLO",
    async () => {
      const connectionCount = 50;
      const { server, wsUrl, close } = await createTransportServer({
        authenticate: async (context) => ({
          userId: `user:${String(context.query.token ?? "anon")}`,
          tenantId: "acme",
        }),
      });
      await server.listen();

      const before = process.memoryUsage().rss;
      const clients = [];
      for (let i = 0; i < connectionCount; i++) {
        clients.push(await authedClient(wsUrl, `m-${i}`));
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      const after = process.memoryUsage().rss;
      const perConnectionBytes = (after - before) / connectionCount;
      const perConnectionKiB = perConnectionBytes / 1024;
      console.log(`memory per connection: ${perConnectionKiB.toFixed(2)} KiB (N=${connectionCount})`);

      for (const c of clients) c.close();
      await close();
      expect(perConnectionKiB).toBeLessThan(500);
    },
  );

  it.skipIf(!process.env.RUN_PERF)(
    "CPU utilization stays bounded under sustained publish load",
    async () => {
      const { server, wsUrl, close } = await createTransportServer({
        authenticate: async (context) => ({
          userId: `user:${String(context.query.token ?? "anon")}`,
          tenantId: "acme",
        }),
      });
      await server.listen();

      const client = await authedClient(wsUrl, "cpu");
      client.send({ type: "join", channel: "lobby" });
      await client.next(); // joined

      const startCpu = process.cpuUsage();
      const startTime = process.hrtime.bigint();
      for (let m = 0; m < 5_000; m++) {
        client.send({ type: "message", channel: "lobby", payload: { m } });
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      const endCpu = process.cpuUsage();
      const endTime = process.hrtime.bigint();

      const elapsedMs = Number(endTime - startTime) / 1_000_000;
      const cpuMs = (endCpu.user - startCpu.user + endCpu.system - startCpu.system) / 1000;
      const utilization = elapsedMs > 0 ? (cpuMs / elapsedMs) * 100 : 0;
      console.log(`CPU utilization @ 5k publishes: ${utilization.toFixed(2)}%`);

      client.close();
      await close();
      expect(utilization).toBeLessThan(100);
    },
  );

  it.skipIf(!process.env.RUN_PERF)(
    "fan-out isolates a slow consumer from healthy recipients",
    async () => {
      const hub = new Hub({
        authProvider: makeAuthProvider(),
        config: { maxQueuedBytesPerConnection: 16 * 1024 } as never,
      });
      const publisher = new FakeTransport("publisher");
      const fast = new FakeTransport("fast");
      const slow = slowSendTransport(new FakeTransport("slow"), 30);
      await hub.connect(publisher, "cred-pub");
      await hub.connect(fast, "cred-fast");
      await hub.connect(slow, "cred-slow");
      await hub.joinRoom("publisher", "room");
      await hub.joinRoom("fast", "room");
      await hub.joinRoom("slow", "room");

      const fastFrames: unknown[] = [];
      fast.onSend((message) => fastFrames.push(message));
      const start = performance.now();
      for (let m = 0; m < 15; m++) {
        await hub.publish("publisher", {
          type: "message",
          roomId: "room",
          payload: { m },
        });
      }
      // Fast recipient received everything; publishing also completed despite
      // the slow transport (fan-out drains per-connection queues).
      while (fastFrames.length < 15) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const fastElapsed = performance.now() - start;
      while (slow.sent.length < 15) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      console.log(`slow-consumer isolation: fast got 15 in ${fastElapsed.toFixed(0)} ms, slow sent=${slow.sent.length}`);

      expect(fastFrames.length).toBe(15);
      expect(slow.sent.length).toBe(15);
      expect(fastElapsed).toBeLessThan(5000);
      hub.close();
    },
  );

  it.skipIf(!process.env.RUN_PERF)(
    "max payload is enforced on the transport",
    async () => {
      const maxPayload = 64;
      const { server, wsUrl, close } = await createTransportServer({
        authenticate: async (context) => ({
          userId: `user:${String(context.query.token ?? "anon")}`,
          tenantId: "acme",
        }),
        limits: { maxPayloadBytes: maxPayload },
      });
      await server.listen();

      const client = await authedClient(wsUrl, "big");
      const oversized = { type: "message", channel: "lobby", payload: { data: "x".repeat(1000) } };
      client.send(oversized);
      // uWS rejects oversized frames; the connection is dropped.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(client.readyState).toBe(3);

      client.close();
      await close();
    },
  );
});
