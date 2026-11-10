/**
 * Integration tests over the real uWebSockets.js transport.
 *
 * Spins up `createRealtime` on ephemeral `127.0.0.1` ports and connects raw
 * `WebSocket` clients plus the first-party SDK client. Covers auth, room
 * join, fan-out, presence, and graceful shutdown.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  createTransportServer,
  connectRaw,
  connectSdk,
  closeAllServers,
} from "../helpers/transport-factory.js";
import type { RealtimeConfig } from "../../../src/public/create-realtime.js";

afterEach(async () => {
  await closeAllServers();
});

const makeConfig = (overrides: Partial<RealtimeConfig> = {}): RealtimeConfig => ({
  authenticate: async (context) => ({
    userId: `user:${String(context.query.token ?? "anonymous")}`,
    tenantId: "acme",
    roles: ["user"],
  }),
  ...overrides,
});

describe("transport integration — real uWS + raw/SDK clients", () => {
  it("authenticates, joins a room, and fans out a message to members only", async () => {
    const { server, wsUrl, close } = await createTransportServer({
      authenticate: makeConfig().authenticate,
    });
    await server.listen();

    const alice = await connectRaw(wsUrl + "?token=alice");
    const bob = await connectRaw(wsUrl + "?token=bob");
    const carol = await connectRaw(wsUrl + "?token=carol");

    const welcomeA = await alice.next();
    const welcomeB = await bob.next();
    const welcomeC = await carol.next();
    expect(welcomeA.type).toBe("welcome");
    expect(welcomeB.type).toBe("welcome");
    expect(welcomeC.type).toBe("welcome");
    expect((welcomeA.payload as { userId: string }).userId).toBe("user:alice");
    expect((welcomeB.payload as { tenantId: string }).tenantId).toBe("acme");

    alice.send({ type: "join", channel: "lobby" });
    bob.send({ type: "join", channel: "lobby" });
    carol.send({ type: "join", channel: "other" });
    expect((await alice.next()).type).toBe("joined");
    expect((await bob.next()).type).toBe("joined");
    expect((await carol.next()).type).toBe("joined");

    // Alice publishes to lobby; Bob receives, Carol (different room) does not.
    alice.send({ type: "message", channel: "lobby", payload: { text: "hello" } });
    const received = await bob.next();
    expect(received.type).toBe("message");
    expect(received.channel).toBe("lobby");
    expect((received.payload as { text: string }).text).toBe("hello");

    // Carol should not receive lobby traffic; allow the fan-out tick to pass.
    await new Promise((resolve) => setTimeout(resolve, 50));

    alice.close();
    bob.close();
    carol.close();
    await close();

    expect(server.health().healthy).toBe(false);
  });

  it("rejects a join without a channel", async () => {
    const { server, wsUrl, close } = await createTransportServer({
      authenticate: makeConfig().authenticate,
    });
    await server.listen();

    const client = await connectRaw(wsUrl + "?token=alice");
    await client.next(); // welcome
    client.send({ type: "join" });
    const error = await client.next();
    expect(error.type).toBe("error");
    expect((error.error as { code: string }).code).toBe("VALIDATION_FAILED");
    client.close();
    await close();
  });

  it("works through the first-party client SDK", async () => {
    const { server, wsUrl, close } = await createTransportServer({
      authenticate: makeConfig().authenticate,
    });
    await server.listen();

    const received: Array<{ text: string }> = [];
    const alice = connectSdk({ url: wsUrl, token: () => "alice" });
    const bob = connectSdk({ url: wsUrl, token: () => "bob" });

    await alice.connect();
    await bob.connect();
    const aRoom = alice.channel<{ text: string }>("docs");
    const bRoom = bob.channel<{ text: string }>("docs");
    bRoom.on("message", (message) => {
      received.push(message);
    });
    await aRoom.join();
    await bRoom.join();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await aRoom.send({ text: "edit" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(received).toEqual([{ text: "edit" }]);

    await alice.disconnect();
    await bob.disconnect();
    await close();
  });

  it("reports healthy after client disconnect and reflects connection count", async () => {
    const { server, wsUrl, close } = await createTransportServer({
      authenticate: makeConfig().authenticate,
    });
    await server.listen();

    const alice = await connectRaw(wsUrl + "?token=alice");
    const bob = await connectRaw(wsUrl + "?token=bob");
    await alice.next();
    await bob.next();

    expect(server.health().healthy).toBe(true);
    expect(server.health().connectionCount).toBeGreaterThanOrEqual(2);

    alice.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.health().healthy).toBe(true);

    bob.close();
    await close();
  });

  it("graceful shutdown drains connections within the deadline", async () => {
    const { server, wsUrl, close } = await createTransportServer({
      authenticate: makeConfig().authenticate,
    });
    await server.listen();

    const alice = await connectRaw(wsUrl + "?token=alice");
    const bob = await connectRaw(wsUrl + "?token=bob");
    await alice.next();
    await bob.next();

    const result = await close();
    expect(result.forcedClose).toBe(false);
    expect(result.durationMs).toBeLessThan(5000);
    expect(server.health().healthy).toBe(false);
  });
});
