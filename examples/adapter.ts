import { createServer } from "node:http";
import { createRealtime, nodeHttpRealtime } from "../src/index.js";

const httpPort = Number(process.env.PORT ?? 3000);
const wsPort = Number(process.env.WS_PORT ?? 4001);

const http = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});

const realtime = createRealtime({
  host: "127.0.0.1",
  port: wsPort,
  path: "/ws",
});

nodeHttpRealtime(http, realtime);

http.listen(httpPort, "127.0.0.1", () => {
  console.log(`http listening on http://127.0.0.1:${httpPort}`);
});

await realtime.listen();
console.log(`ws listening on ${realtime.wsUrl}`);
