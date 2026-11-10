import { createRealtimeClient } from "../src/client/index.js";

const port = Number(process.env.PORT ?? 4001);
const user = process.env.USER_ID ?? "alice";
const room = process.env.ROOM ?? "lobby";
const url = `ws://127.0.0.1:${port}/ws`;

const client = createRealtimeClient({
  url,
  codec: "json",
  auth: { token: async () => user },
  reconnect: { enabled: false, maxAttempts: 0 },
});

client.on("error", (error) => {
  console.error("client error", error);
});

await client.connect();
const channel = client.channel<{ text: string; from?: string }>(room);
channel.on("message", (message) => {
  console.log("message", message);
});
await channel.join();
await channel.send({ text: `hello from ${user}`, from: user });
console.log(`connected as ${user} on ${url}`);
