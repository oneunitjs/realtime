import { createRealtime } from "../src/index.js";

const port = Number(process.env.PORT ?? 4001);

const realtime = createRealtime({
  host: "127.0.0.1",
  port,
  path: "/ws",
});

await realtime.listen();
console.log(`standalone listening on ${realtime.wsUrl}`);

process.on("SIGINT", () => {
  void realtime.close().then(() => process.exit(0));
});
