import { createRealtime } from "../src/index.js";

const port = Number(process.env.PORT ?? 4001);
const host = process.env.HOST ?? "127.0.0.1";

const realtime = createRealtime({
  host,
  port,
  path: "/ws",
  authenticate: async (handshake) => {
    const token = handshake.query.token ?? "guest";
    return {
      userId: token,
      tenantId: handshake.query.tenant ?? "default",
      roles: ["user"],
      sessionId: token,
    };
  },
});

const address = await realtime.listen();
console.log(`chat listening on ${realtime.wsUrl ?? `${address.host}:${address.port}${address.path}`}`);

const shutdown = async () => {
  await realtime.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
