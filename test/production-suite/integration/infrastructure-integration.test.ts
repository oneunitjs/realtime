/**
 * Host-adapter integration tests.
 *
 * Mounts the Hub behind express, fastify, and node-http via `attachHubToServer`
 * (uWS owns a dedicated WebSocket listener on a separate port; the framework
 * HTTP server keeps serving non-WebSocket requests). Verifies the WebSocket
 * upgrade path works per framework, non-WS HTTP requests are still handled,
 * and origin allowlisting rejects disallowed upgrades.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import express from "express";
import Fastify from "fastify";
import { attachHubToServer } from "../../../src/transport/attach.js";
import { Hub } from "../../../src/core/core-hub.js";
import type { TransportConnection } from "../../../src/core/connection/connection.types.js";
import { connectRaw } from "../helpers/transport-factory.js";
import { closeAllServers } from "../helpers/transport-factory.js";

afterEach(async () => {
  await closeAllServers();
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
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

function makeHub(): Hub {
  return new Hub({});
}

async function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await response.text();
  return { status: response.status, body };
}

interface FrameworkFixture {
  httpPort: number;
  wsPort: number;
  stop: () => Promise<void>;
}

function attachHub(httpServer: HttpServer, hub: Hub, wsPort: number, allowedOrigins?: string[]): void {
  attachHubToServer(httpServer as unknown, {
    hub,
    path: "/ws",
    port: wsPort,
    host: "127.0.0.1",
    allowedOrigins,
    onConnection: (conn: TransportConnection) => {
      void hub.connect(conn, "cred-anonymous");
    },
  });
}

async function startFrameworkServer(
  framework: "express" | "fastify" | "node-http",
): Promise<FrameworkFixture> {
  const httpPort = await freePort();
  const wsPort = await freePort();
  const hub = makeHub();
  let stop = async () => {};

  if (framework === "express") {
    const app = express();
    app.get("/health", (_req, res) => {
      res.status(200).send("ok");
    });
    const httpServer = createHttpServer(app);
    attachHub(httpServer, hub, wsPort);
    await new Promise<void>((resolve) => {
      httpServer.listen(httpPort, "127.0.0.1");
      httpServer.once("listening", resolve);
    });
    stop = async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      hub.close();
    };
  } else if (framework === "fastify") {
    const app = Fastify();
    app.get("/health", async () => ({ ok: true }));
    const httpServer = app.server;
    attachHub(httpServer, hub, wsPort);
    await app.listen({ port: httpPort, host: "127.0.0.1" });
    stop = async () => {
      await app.close();
      hub.close();
    };
  } else {
    const httpServer = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    attachHub(httpServer, hub, wsPort);
    await new Promise<void>((resolve) => {
      httpServer.listen(httpPort, "127.0.0.1");
      httpServer.once("listening", resolve);
    });
    stop = async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      hub.close();
    };
  }

  return { httpPort, wsPort, stop };
}

describe("infrastructure integration — host adapters", () => {
  it.each(["express", "fastify", "node-http"] as const)(
    "serves WebSocket upgrades and HTTP on %s",
    async (framework) => {
      const { httpPort, wsPort, stop } = await startFrameworkServer(framework);

      const response = await httpGet(httpPort, "/health");
      expect(response.status).toBe(200);

      const client = await connectRaw(`ws://127.0.0.1:${wsPort}/ws`);
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 50));

      await stop();
    },
  );

  it("rejects WebSocket upgrades from disallowed origins", async () => {
    const httpPort = await freePort();
    const wsPort = await freePort();
    const hub = makeHub();
    const app = express();
    const httpServer = createHttpServer(app);
    attachHub(httpServer, hub, wsPort, ["https://app.example.com"]);
    await new Promise<void>((resolve) => {
      httpServer.listen(httpPort, "127.0.0.1");
      httpServer.once("listening", resolve);
    });

    // Node's WebSocket does not send an allowed origin → upgrade rejected (403).
    await expect(connectRaw(`ws://127.0.0.1:${wsPort}/ws`)).rejects.toThrow();

    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    hub.close();
  });
});
