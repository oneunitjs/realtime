import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { connect as tcpConnect, createServer } from "node:net";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
// uWebSockets.js v20 has no client WebSocket class; use the global WebSocket.
const WebSocket = globalThis.WebSocket as typeof globalThis.WebSocket;
import { decode } from "notepack.io";

// Resolving a path against a file URL treats the file itself as the last
// segment, so reaching the package root takes two levels up, not one.
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const tsxCli = fileURLToPath(new URL("node_modules/tsx/dist/cli.mjs", new URL("../", import.meta.url)));

interface RunningExample {
  child: ChildProcessByStdio<null, Readable, Readable>;
  port: number;
  output: string;
}

const running: RunningExample[] = [];

const BOOT_TIMEOUT_MS = 20_000;

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

function startExample(script: string, port: number, env: NodeJS.ProcessEnv = {}): RunningExample {
  const child = spawn(process.execPath, [tsxCli, `examples/${script}`], {
    cwd: packageRoot,
    env: { ...process.env, PORT: String(port), LOG_LEVEL: "silent", ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  const instance: RunningExample = { child, port, output: "" };
  const collect = (chunk: Buffer) => {
    instance.output += chunk.toString();
  };

  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("error", (error) => {
    instance.output += `spawn error: ${error.message}`;
  });
  running.push(instance);

  return instance;
}

async function waitForPort(port: number, instance: RunningExample): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (instance.child.exitCode !== null) {
      throw new Error(`example exited early (${instance.child.exitCode}):\n${instance.output}`);
    }

    const reachable = await new Promise<boolean>((resolve) => {
      const probe = tcpConnect({ host: "127.0.0.1", port });

      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });

    if (reachable) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`example did not start listening on ${port}:\n${instance.output}`);
}

interface TestClient {
  frames: Record<string, unknown>[];
  next(timeout?: number): Promise<Record<string, unknown>>;
  nextOfType(type: string, timeout?: number): Promise<Record<string, unknown>>;
  send(data: unknown): void;
  close(): void;
}

function connect(url: string): Promise<TestClient> {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const frames: Record<string, unknown>[] = [];
  const waiters: Array<(frame: Record<string, unknown>) => void> = [];
  const filters: Array<(frame: Record<string, unknown>) => boolean> = [];

  const flush = (): void => {
    while (waiters.length > 0) {
      const index = filters[0] ? frames.findIndex(filters[0]) : 0;

      if (index < 0) {
        return;
      }

      const [frame] = frames.splice(index, 1);
      filters.shift();
      waiters.shift()?.(frame);
    }
  };

  socket.addEventListener("message", (event: MessageEvent) => {
    const data = event.data;
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : new Uint8Array(data as ArrayBuffer);
    let frame: Record<string, unknown>;
    try {
      frame = decode(Buffer.from(bytes)) as Record<string, unknown>;
    } catch (e) {
      return;
    }
    if (waiters.length > 0) {
      frames.push(frame);
      flush();
      return;
    }

    frames.push(frame);
  });

  return new Promise((resolve, reject) => {
    socket.addEventListener(
      "error",
      () => reject(new Error("WebSocket error")),
      { once: true },
    );
    socket.addEventListener(
      "open",
      () => {
        resolve({
          frames,
          next(timeout = 5000) {
            const buffered = frames.shift();
            if (buffered) {
              return Promise.resolve(buffered);
            }

            return new Promise((resolveFrame, rejectFrame) => {
              const timer = setTimeout(
                () => rejectFrame(new Error("no frame received before timeout")),
                timeout,
              );

              waiters.push((frame) => {
                clearTimeout(timer);
                resolveFrame(frame);
              });
              filters.push(() => true);
              flush();
            });
          },

          nextOfType(type, timeout = 5000) {
            return new Promise((resolveFrame, rejectFrame) => {
              const timer = setTimeout(
                () =>
                  rejectFrame(
                    new Error(`no "${type}" frame received before timeout`),
                  ),
                timeout,
              );

              waiters.push((frame) => {
                clearTimeout(timer);
                resolveFrame(frame);
              });
              filters.push((frame) => frame.type === type);
              flush();
            });
          },
          send(data: unknown) {
            socket.send(JSON.stringify(data));
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

const clients: TestClient[] = [];

afterAll(async () => {
  for (const client of clients) {
    client.close();
  }

  for (const { child } of running) {
    if (child.pid === undefined || child.exitCode !== null) {
      continue;
    }

    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
});

async function connectTracked(url: string): Promise<TestClient> {
  const client = await connect(url);
  clients.push(client);
  return client;
}

// ---------------------------------------------------------------------------
// Examples smoke tests
// ---------------------------------------------------------------------------

describe("examples", () => {
  it("uWebSockets.js can create an app and listen", async () => {
    let mod: { App?: () => { listen: Function; close: Function } };
    try {
      mod = await import("uwebsocket");
    } catch {
      return;
    }
    if (typeof mod.App !== "function") {
      return;
    }
    const app = mod.App();

    await new Promise<void>((resolve, reject) => {
      app.listen("127.0.0.1", 0, (token: unknown) => {
        if (token !== false) {
          resolve();
        } else {
          reject(new Error("uWS listen failed"));
        }
      });
    });

    app.close();
  });
});

