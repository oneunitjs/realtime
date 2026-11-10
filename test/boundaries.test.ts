import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Boundary tests for the consolidated uWebSockets.js-only architecture
// (docs/architecture-consolidation-uws-plan-v2.md).
//
// Invariants: a single Hub runtime, a single uWS transport, no `ws` engine,
// and one dependency direction (only the transport layer imports uWS).

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceDir = join(packageRoot, "src");

function read(name: string): string {
  return readFileSync(join(sourceDir, name), "utf8");
}

/** Import specifiers of a module, static and dynamic alike. */
function importsOf(name: string): string[] {
  const source = read(name);
  const specifiers: string[] = [];
  const pattern = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;

  for (const match of source.matchAll(pattern)) {
    specifiers.push(match[1]);
  }

  return specifiers;
}

function bareModules(name: string): string[] {
  return importsOf(name).filter((specifier) => !specifier.startsWith("."));
}

const BROKER = /kafka|amqp|rabbit|nats|redis|sqs|pubsub|bullmq/i;
const FRAMEWORK_OR_UWS = /^(uwebsocket|fastify|@fastify|express|koa|ws)$/;

describe("module boundaries (uWS-only consolidation)", () => {
  it("keeps the Hub free of transports, frameworks, and brokers", () => {
    for (const dependency of bareModules("core/core-hub.ts")) {
      expect(dependency, `src/core/core-hub.ts imports ${dependency}`).not.toMatch(
        FRAMEWORK_OR_UWS,
      );
      expect(dependency, `src/core/core-hub.ts imports ${dependency}`).not.toMatch(
        BROKER,
      );
    }
  });

  it("only the uWS transport layer imports uWebSockets.js", () => {
    // The transport adapter is the sole static importer of uwebsocket.
    expect(importsOf("transport/uws/uws-transport.ts")).toContain("uwebsocket");

    // Every other top-level source module must not import uWS directly.
    for (const name of readdirSync(sourceDir).filter((n) => n.endsWith(".ts"))) {
      for (const dependency of bareModules(name)) {
        expect(
          dependency,
          `src/${name} must not import ${dependency} (only the uWS transport may)`,
        ).not.toMatch(/^uwebsocket$/);
      }
    }
  });

  it("declares uwebsocket as the sole WebSocket engine dependency", () => {
    const manifest = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string>; devDependencies?: Record<string, string> };

    expect(manifest.dependencies.uwebsocket).toBeDefined();
    expect(manifest.dependencies.ws).toBeUndefined();
    expect(manifest.devDependencies?.["@types/ws"]).toBeUndefined();
  });

  it("does not retain the deleted duplicate Hub or adapter entry points", () => {
    expect(existsSync(join(sourceDir, "core", "hub.ts"))).toBe(false);
    expect(existsSync(join(sourceDir, "transport", "adapter.ts"))).toBe(false);
  });

  it("ships no broker-shaped export from the public index", async () => {
    const root = (await import("../src/index.js")) as Record<string, unknown>;

    // Presence stores (e.g. RedisPresenceStore) are stores, not transport
    // brokers, so they are excluded from this assertion.
    expect(
      Object.keys(root)
        .filter((name) => BROKER.test(name) && !name.endsWith("Store")),
    ).toEqual([]);
  });
});
