import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { createRealtime, decodeFrame, encodeFrame } from "../src/index.js";
import { createRealtimeClient } from "../src/client/index.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("could not reserve a port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RawClient {
  frames: Array<Record<string, unknown>>;
  send(envelope: Record<string, unknown>): void;
  next(timeout?: number): Promise<Record<string, unknown>>;
  close(): void;
}

function connectRaw(url: string): Promise<RawClient> {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const frames: Array<Record<string, unknown>> = [];
  const waiters: Array<(frame: Record<string, unknown>) => void> = [];

  socket.addEventListener("message", (event: MessageEvent) => {
    const data = event.data;
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : new Uint8Array(data as ArrayBuffer);
    const frame = decodeFrame(bytes, { codec: "json" }).envelope as unknown as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(frame);
      return;
    }
    frames.push(frame);
  });

  return new Promise((resolve, reject) => {
    socket.addEventListener("error", () => reject(new Error("WebSocket error")), { once: true });
    socket.addEventListener(
      "open",
      () => {
        resolve({
          frames,
          send(envelope) {
            socket.send(
              encodeFrame({ protocolVersion: 1, ...envelope } as never, { codec: "json" }),
            );
          },
          next(timeout = 5000) {
            const buffered = frames.shift();
            if (buffered) {
              return Promise.resolve(buffered);
            }
            return new Promise((resolveFrame, rejectFrame) => {
              const timer = setTimeout(() => rejectFrame(new Error("no frame")), timeout);
              waiters.push((frame) => {
                clearTimeout(timer);
                resolveFrame(frame);
              });
            });
          },
          close() {
            socket.close();
          },
        });
      },
      { once: true },
    );
  });
}

const servers: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await server?.close();
  }
});

describe("production websocket path", () => {
  it("authenticates, joins, and fans out a room message", async () => {
    const port = await freePort();
    const realtime = createRealtime({
      host: "127.0.0.1",
      port,
      path: "/ws",
      authenticate: async (handshake) => ({
        userId: handshake.query.token ?? "anonymous",
        tenantId: "acme",
      }),
    });
    servers.push(realtime);
    await realtime.listen();

    const alice = await connectRaw(`ws://127.0.0.1:${port}/ws?token=alice`);
    const bob = await connectRaw(`ws://127.0.0.1:${port}/ws?token=bob`);

    const welcomeA = await alice.next();
    const welcomeB = await bob.next();
    expect(welcomeA.type).toBe("welcome");
    expect(welcomeB.type).toBe("welcome");
    expect((welcomeA.payload as { userId: string }).userId).toBe("alice");

    alice.send({ type: "join", channel: "lobby" });
    bob.send({ type: "join", channel: "lobby" });
    expect((await alice.next()).type).toBe("joined");
    expect((await bob.next()).type).toBe("joined");

    alice.send({ type: "message", channel: "lobby", payload: { text: "hello" } });
    const received = await bob.next();
    expect(received.type).toBe("message");
    expect(received.channel).toBe("lobby");
    expect((received.payload as { text: string }).text).toBe("hello");

    alice.close();
    bob.close();
    await wait(50);
    expect(realtime.health().healthy).toBe(true);
  });

  it("rejects a missing join channel", async () => {
    const port = await freePort();
    const realtime = createRealtime({
      host: "127.0.0.1",
      port,
      path: "/ws",
      authenticate: async () => ({ userId: "anonymous", tenantId: "default" }),
    });
    servers.push(realtime);
    await realtime.listen();

    const client = await connectRaw(`ws://127.0.0.1:${port}/ws`);
    await client.next();
    client.send({ type: "join" });
    const error = await client.next();
    expect(error.type).toBe("error");
    client.close();
  });

  it("works through the first-party client SDK", async () => {
    const port = await freePort();
    const realtime = createRealtime({
      host: "127.0.0.1",
      port,
      path: "/ws",
      authenticate: async (handshake) => ({
        userId: handshake.query.token ?? "anonymous",
        tenantId: "default",
      }),
    });
    servers.push(realtime);
    await realtime.listen();

    const received: Array<{ text: string }> = [];
    const alice = createRealtimeClient({
      url: realtime.wsUrl!,
      codec: "json",
      auth: { token: async () => "alice" },
      reconnect: { enabled: false, maxAttempts: 0 },
    });
    const bob = createRealtimeClient({
      url: realtime.wsUrl!,
      codec: "json",
      auth: { token: async () => "bob" },
      reconnect: { enabled: false, maxAttempts: 0 },
    });

    await alice.connect();
    await bob.connect();
    const aRoom = alice.channel<{ text: string }>("docs");
    const bRoom = bob.channel<{ text: string }>("docs");
    bRoom.on("message", (message) => {
      received.push(message);
    });
    await aRoom.join();
    await bRoom.join();
    await wait(50);
    await aRoom.send({ text: "edit" });
    await wait(150);
    expect(received).toEqual([{ text: "edit" }]);

    await alice.disconnect();
    await bob.disconnect();
  });
});
