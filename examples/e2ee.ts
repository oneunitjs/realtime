import {
  createHub,
  EnvelopeService,
  generateDeviceKeys,
  e2eeReady,
} from "../src/index.js";
import { FakeTransport } from "../src/transport/testing/transport-connection.js";

await e2eeReady();

const alice = generateDeviceKeys();
const bob = generateDeviceKeys();
const envelopes = new EnvelopeService();

const hub = createHub({
  envelopeService: envelopes,
  authProvider: {
    authenticate: async (credential) => ({
      userId: credential ?? "anonymous",
      tenantId: "default",
      roles: ["user"],
      sessionId: credential ?? "anonymous",
    }),
  },
});

const aliceTransport = new FakeTransport("alice");
const bobTransport = new FakeTransport("bob");
await hub.connect(aliceTransport, "alice");
await hub.connect(bobTransport, "bob");
await hub.joinRoom("alice", "dm");
await hub.joinRoom("bob", "dm");

const sealed = await envelopes.seal({
  plaintext: new TextEncoder().encode("secret"),
  recipientPublicKey: bob.x25519PublicKey,
  senderX25519KeyPair: {
    publicKey: alice.x25519PublicKey,
    privateKey: alice.x25519PrivateKey,
  },
  senderEd25519KeyPair: {
    publicKey: alice.ed25519PublicKey,
    privateKey: alice.ed25519PrivateKey,
  },
  conversationId: "dm",
  senderUserId: "alice",
  senderDeviceId: alice.deviceId,
  keyEpoch: 1,
});

const result = await hub.sendEnvelope("alice", sealed);
console.log("e2ee routed", result);
hub.close();
