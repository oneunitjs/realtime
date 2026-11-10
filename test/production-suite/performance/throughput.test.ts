/**
 * Throughput benchmarks (gated behind `RUN_PERF=1`).
 *
 * Measures sustained publish throughput, concurrent connection ramp, and
 * broadcast completion time over the real uWS transport.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createTransportServer, connectRaw, closeAllServers } from "../helpers/transport-factory.js";

afterEach(async () => {
  await closeAllServers();
});

async function authedClient(wsUrl: string, token: string) {
  const client = await connectRaw(wsUrl + `?token=${token}`);
  await client.next(); // welcome
  return client;
}

describe("performance — throughput", () => {
  it.skipIf(!process.env.RUN_PERF)(
    "sustained publish throughput: N clients publish M messages each",
    async () => {
      const clientCount = 10;
      const messagesPerClient = 100;
      const { server, wsUrl, close } = await createTransportServer({
        authenticate: async (context) => ({
          userId: `user:${String(context.query.token ?? "anon")}`,
          tenantId: "acme",
        }),
      });
      await server.listen();

      const clients = [];
      for (let i = 0; i < clientCount; i++) {
        const c = await authedClient(wsUrl, `p-${i}`);
        c.send({ type: "join", channel: "lobby" });
        await c.next(); // joined
        clients.push(c);
      }

      const start = performance.now();
      let sent = 0;
      for (const c of clients) {
        for (let m = 0; m < messagesPerClient; m++) {
          c.send({ type: "message", channel: "lobby", payload: { m } });
          sent += 1;
        }
      }
      // Allow fan-out to flush.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const elapsedMs = performance.now() - start;
      const msgPerSec = (sent / elapsedMs) * 1000;
      console.log(`sustained publish: ${sent} messages in ${elapsedMs.toFixed(0)} ms ≈ ${msgPerSec.toFixed(0)} msg/s`);

      for (const c of clients) c.close();
      await close();
      expect(msgPerSec).toBeGreaterThan(0);
    },
  );

  it.skipIf(!process.env.RUN_PERF)(
    "concurrent connection ramp matches health().connectionCount",
    async () => {
      const target = 100;
      const { server, wsUrl, close } = await createTransportServer({
        authenticate: async (context) => ({
          userId: `user:${String(context.query.token ?? "anon")}`,
          tenantId: "acme",
        }),
      });
      await server.listen();

      const clients = [];
      const batch = 25;
      for (let opened = 0; opened < target; opened += batch) {
        const promises = [];
        for (let i = 0; i < batch && opened + i < target; i++) {
          promises.push(authedClient(wsUrl, `ramp-${opened + i}`));
        }
        const batchClients = await Promise.all(promises);
        clients.push(...batchClients);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const health = server.health();
      console.log(`ramp: opened=${clients.length} connectionCount=${health.connectionCount} healthy=${health.healthy}`);

      expect(health.healthy).toBe(true);
      expect(health.connectionCount).toBeGreaterThanOrEqual(target);

      for (const c of clients) c.close();
      await close();
    },
  );

  it.skipIf(!process.env.RUN_PERF)(
    "broadcast throughput: 1 publisher to N subscribers, M messages",
    async () => {
      const subscriberCount = 50;
      const messageCount = 100;
      const { server, wsUrl, close } = await createTransportServer({
        authenticate: async (context) => ({
          userId: `user:${String(context.query.token ?? "anon")}`,
          tenantId: "acme",
        }),
      });
      await server.listen();

      const publisher = await authedClient(wsUrl, "pub");
      publisher.send({ type: "join", channel: "lobby" });
      await publisher.next(); // joined

      const subscribers = [];
      for (let i = 0; i < subscriberCount; i++) {
        const sub = await authedClient(wsUrl, `b-${i}`);
        sub.send({ type: "join", channel: "lobby" });
        await sub.next(); // joined
        subscribers.push(sub);
      }

      const start = performance.now();
      for (let m = 0; m < messageCount; m++) {
        publisher.send({ type: "message", channel: "lobby", payload: { m } });
      }
      // Wait for all subscribers to receive all messages.
      await Promise.all(
        subscribers.map(async (sub) => {
          for (let m = 0; m < messageCount; m++) {
            await sub.next();
          }
        }),
      );
      const elapsedMs = performance.now() - start;
      const totalDelivered = subscriberCount * messageCount;
      const msgPerSec = (totalDelivered / elapsedMs) * 1000;
      console.log(`broadcast: ${totalDelivered} deliveries in ${elapsedMs.toFixed(0)} ms ≈ ${msgPerSec.toFixed(0)} msg/s`);

      publisher.close();
      for (const sub of subscribers) sub.close();
      await close();
      expect(msgPerSec).toBeGreaterThan(0);
    },
  );
});
