/**
 * E2EE key rotation and envelope integration tests.
 *
 * Verifies seal/open round-trips, opaque envelope routing through the Hub
 * (plaintext never on the wire), stale-epoch rejection (fail closed), sender
 * binding to the authenticated principal, and malformed-envelope errors.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hub } from "../../../src/core/core-hub.js";
import { FakeTransport } from "../../../src/transport/testing/transport-connection.js";
import {
  EnvelopeService,
  generateDeviceKeys,
  InvalidEnvelopeError,
  UnsupportedVersionError,
} from "../../../src/e2ee/index.js";
import { createTestHub, connectClient } from "../helpers/hub-factory.js";

await (await import("libsodium-wrappers")).ready;

function collectFrames(transport: FakeTransport): unknown[] {
  const frames: unknown[] = [];
  transport.onSend((message) => {
    frames.push(message);
  });
  return frames;
}

async function sealEnvelope(service: EnvelopeService, opts: {
  senderUserId: string;
  recipientKeys: ReturnType<typeof generateDeviceKeys>;
  senderKeys: ReturnType<typeof generateDeviceKeys>;
  conversationId: string;
  keyEpoch: number;
  messageId: string;
  plaintext: string;
}) {
  return service.seal({
    plaintext: new TextEncoder().encode(opts.plaintext),
    recipientPublicKey: opts.recipientKeys.x25519PublicKey,
    senderX25519KeyPair: {
      publicKey: opts.senderKeys.x25519PublicKey,
      privateKey: opts.senderKeys.x25519PrivateKey,
    },
    senderEd25519KeyPair: {
      publicKey: opts.senderKeys.ed25519PublicKey,
      privateKey: opts.senderKeys.ed25519PrivateKey,
    },
    conversationId: opts.conversationId,
    senderUserId: opts.senderUserId,
    senderDeviceId: opts.senderKeys.deviceId,
    keyEpoch: opts.keyEpoch,
    messageId: opts.messageId,
  });
}

describe("E2EE rotation and envelope routing", () => {
  let hub: Hub;
  let bob: FakeTransport;
  let bobFrames: unknown[];
  let service: EnvelopeService;

  beforeEach(async () => {
    service = new EnvelopeService({ allowedEpochs: new Set([1]) });
    hub = createTestHub({ envelopeService: service });
    await connectClient(hub, "c-alice", "cred-alice");
    bob = await connectClient(hub, "c-bob", "cred-bob");
    await hub.joinRoom("c-alice", "conv-1");
    await hub.joinRoom("c-bob", "conv-1");
    bobFrames = collectFrames(bob);
  });

  afterEach(() => {
    hub.close();
  });

  it("seal/open round-trip recovers the plaintext", async () => {
    const aliceKeys = generateDeviceKeys();
    const bobKeys = generateDeviceKeys();

    const envelope = await sealEnvelope(service, {
      senderUserId: "alice",
      recipientKeys: bobKeys,
      senderKeys: aliceKeys,
      conversationId: "conv-1",
      keyEpoch: 1,
      messageId: "msg-1",
      plaintext: "hello e2ee",
    });

    const plaintext = await service.open({
      envelope,
      recipientX25519PrivateKey: bobKeys.x25519PrivateKey,
      senderX25519PublicKey: aliceKeys.x25519PublicKey,
      senderEd25519PublicKey: aliceKeys.ed25519PublicKey,
      keyEpoch: 1,
    });
    expect(new TextDecoder().decode(plaintext)).toBe("hello e2ee");
  });

  it("routes an opaque envelope to room members without decrypting it", async () => {
    const aliceKeys = generateDeviceKeys();
    const bobKeys = generateDeviceKeys();

    const envelope = await sealEnvelope(service, {
      senderUserId: "alice",
      recipientKeys: bobKeys,
      senderKeys: aliceKeys,
      conversationId: "conv-1",
      keyEpoch: 1,
      messageId: "msg-1",
      plaintext: "never on the wire",
    });

    const result = await hub.sendEnvelope("c-alice", envelope);
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(bobFrames.length).toBe(1);
    const received = bobFrames[0] as { data: Uint8Array };
    const wire = JSON.stringify(received);
    expect(wire).not.toContain("never on the wire");
    expect(received.data).toBeInstanceOf(Uint8Array);
    expect(received.data.length).toBeGreaterThan(0);

    // Bob can decrypt it client-side.
    const plaintext = await service.open({
      envelope,
      recipientX25519PrivateKey: bobKeys.x25519PrivateKey,
      senderX25519PublicKey: aliceKeys.x25519PublicKey,
      senderEd25519PublicKey: aliceKeys.ed25519PublicKey,
      keyEpoch: 1,
    });
    expect(new TextDecoder().decode(plaintext)).toBe("never on the wire");
  });

  it("rejects an envelope sealed under a stale key epoch", async () => {
    const staleService = new EnvelopeService({ allowedEpochs: new Set([1]) });
    const recipientService = new EnvelopeService({ allowedEpochs: new Set([2]) });
    const aliceKeys = generateDeviceKeys();
    const bobKeys = generateDeviceKeys();

    const envelope = await sealEnvelope(staleService, {
      senderUserId: "alice",
      recipientKeys: bobKeys,
      senderKeys: aliceKeys,
      conversationId: "conv-1",
      keyEpoch: 1,
      messageId: "msg-stale",
      plaintext: "stale",
    });

    await expect(
      recipientService.open({
        envelope,
        recipientX25519PrivateKey: bobKeys.x25519PrivateKey,
        senderX25519PublicKey: aliceKeys.x25519PublicKey,
        senderEd25519PublicKey: aliceKeys.ed25519PublicKey,
        keyEpoch: 2,
      }),
    ).rejects.toThrow();
  });

  it("binds envelope sender identity to the authenticated principal", async () => {
    const aliceKeys = generateDeviceKeys();
    const bobKeys = generateDeviceKeys();

    const envelope = await sealEnvelope(service, {
      senderUserId: "eve", // mismatch: authenticated principal is alice
      recipientKeys: bobKeys,
      senderKeys: aliceKeys,
      conversationId: "conv-1",
      keyEpoch: 1,
      messageId: "msg-1",
      plaintext: "x",
    } as never);

    await expect(hub.sendEnvelope("c-alice", envelope)).rejects.toThrow();
  });

  it("rejects malformed envelopes with fail-closed errors", async () => {
    const bad = {
      protocolVersion: 99,
      conversationId: "conv-1",
      senderUserId: "alice",
      senderDeviceId: "dev-1",
      messageId: "msg-bad",
      keyEpoch: 1,
      nonce: new Uint8Array(24),
      ciphertext: new Uint8Array([1]),
    } as never;

    await expect(hub.sendEnvelope("c-alice", bad)).rejects.toThrow(
      UnsupportedVersionError,
    );

    const wrongNonce = {
      protocolVersion: 1,
      conversationId: "conv-1",
      senderUserId: "alice",
      senderDeviceId: "dev-1",
      messageId: "msg-bad",
      keyEpoch: 1,
      nonce: new Uint8Array(16),
      ciphertext: new Uint8Array([1, 2, 3]),
    } as never;
    await expect(hub.sendEnvelope("c-alice", wrongNonce)).rejects.toThrow(
      InvalidEnvelopeError,
    );
  });
});
