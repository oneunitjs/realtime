import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  EnvelopeService,
  generateDeviceKeys,
  MemoryDeviceIdentityManager,
  MemoryKeyDirectory,
  ReplayGuard,
  E2EE_PROTOCOL_VERSION,
  InvalidSignatureError,
  UnknownEpochError,
  RevokedDeviceError,
  AeadFailureError,
  ReplayError,
  UnsupportedVersionError,
  InvalidEnvelopeError,
  EnvelopeTooLargeError,
  Hub,
  type AuthProvider,
} from "../../src/index.js";
import { ForbiddenError } from "../../src/error/index.js";
import { FakeTransport } from "../../src/transport/testing/transport-connection.js";

function makeAuthProvider(principal: { userId: string; tenantId: string }): AuthProvider {
  return {
    authenticate: async () => ({
      userId: principal.userId,
      tenantId: principal.tenantId,
      roles: ["user"],
      sessionId: "s1",
    }),
  };
}

function makeHubWithE2EE(opts: {
  authorize?: (
    action: string,
    principal: { userId: string; tenantId: string },
    resourceId?: string,
    tenantId?: string
  ) => boolean;
} = {}): Hub {
  return new Hub({
    authProvider: makeAuthProvider({ userId: "alice", tenantId: "tenant-a" }),
    authorize: opts.authorize ?? (() => true),
    envelopeService: new EnvelopeService({
      maxEnvelopeBytes: 64 * 1024,
      allowedEpochs: new Set([1]),
    }),
  });
}

async function aliceConnection(hub: Hub) {
  const transport = new FakeTransport("c-alice");
  await hub.connect(transport, "cred-alice");
  return transport;
}

function bobKeys() {
  return generateDeviceKeys();
}

describe("E2EE envelope seal/open round-trip", () => {
  beforeEach(async () => {
    await (await import("libsodium-wrappers")).ready;
  });

  it("seal then open recovers the plaintext", async () => {
    const alice = generateDeviceKeys();
    const bob = generateDeviceKeys();
    const service = new EnvelopeService();

    const envelope = await service.seal({
      plaintext: new TextEncoder().encode("hello document"),
      recipientPublicKey: bob.x25519PublicKey,
      senderX25519KeyPair: {
        publicKey: alice.x25519PublicKey,
        privateKey: alice.x25519PrivateKey,
      },
      senderEd25519KeyPair: {
        publicKey: alice.ed25519PublicKey,
        privateKey: alice.ed25519PrivateKey,
      },
      conversationId: "conv-1",
      senderUserId: "alice",
      senderDeviceId: alice.deviceId,
      keyEpoch: 1,
      messageId: "msg-1",
    });

    expect(envelope.protocolVersion).toBe(E2EE_PROTOCOL_VERSION);
    expect(envelope.senderUserId).toBe("alice");
    expect(envelope.senderDeviceId).toBe(alice.deviceId);
    expect(envelope.keyEpoch).toBe(1);
    expect(envelope.nonce.length).toBe(24);
    expect(envelope.ciphertext.length).toBeGreaterThan(0);
    expect(envelope.signature).toBeDefined();

    const plaintext = await service.open({
      envelope,
      recipientX25519PrivateKey: bob.x25519PrivateKey,
      senderX25519PublicKey: alice.x25519PublicKey,
      senderEd25519PublicKey: alice.ed25519PublicKey,
      keyEpoch: 1,
    });

    expect(new TextDecoder().decode(plaintext)).toBe("hello document");
  });

  it("rejects tampered ciphertext (AEAD failure, fail closed)", async () => {
    const alice = generateDeviceKeys();
    const bob = generateDeviceKeys();
    const service = new EnvelopeService();

    const envelope = await service.seal({
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
      conversationId: "conv-1",
      senderUserId: "alice",
      senderDeviceId: alice.deviceId,
      keyEpoch: 1,
      messageId: "msg-1",
    });

    // Flip a bit in the ciphertext.
    const tampered = { ...envelope, ciphertext: new Uint8Array(envelope.ciphertext) };
    tampered.ciphertext[0] ^= 0xff;

    // Tampering ciphertext invalidates the signature (which covers the
    // ciphertext), so this is rejected as an invalid signature (fail closed).
    await expect(
      service.open({
        envelope: tampered,
        recipientX25519PrivateKey: bob.x25519PrivateKey,
        senderX25519PublicKey: alice.x25519PublicKey,
        senderEd25519PublicKey: alice.ed25519PublicKey,
        keyEpoch: 1,
      }),
    ).rejects.toBeInstanceOf(InvalidSignatureError);
  });

  it("rejects decryption with the wrong recipient key (AEAD failure)", async () => {
    const alice = generateDeviceKeys();
    const bob = generateDeviceKeys();
    const charlie = generateDeviceKeys();
    const service = new EnvelopeService();

    const envelope = await service.seal({
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
      conversationId: "conv-1",
      senderUserId: "alice",
      senderDeviceId: alice.deviceId,
      keyEpoch: 1,
      messageId: "msg-1",
    });

    // Signature is valid (signed by alice), but charlie's key cannot decrypt.
    await expect(
      service.open({
        envelope,
        recipientX25519PrivateKey: charlie.x25519PrivateKey,
        senderX25519PublicKey: alice.x25519PublicKey,
        senderEd25519PublicKey: alice.ed25519PublicKey,
        keyEpoch: 1,
      }),
    ).rejects.toBeInstanceOf(AeadFailureError);
  });

  it("rejects an invalid signature (fail closed)", async () => {
    const alice = generateDeviceKeys();
    const bob = generateDeviceKeys();
    const service = new EnvelopeService();

    const envelope = await service.seal({
      plaintext: new TextEncoder().encode("x"),
      recipientPublicKey: bob.x25519PublicKey,
      senderX25519KeyPair: {
        publicKey: alice.x25519PublicKey,
        privateKey: alice.x25519PrivateKey,
      },
      senderEd25519KeyPair: {
        publicKey: alice.ed25519PublicKey,
        privateKey: alice.ed25519PrivateKey,
      },
      conversationId: "conv-1",
      senderUserId: "alice",
      senderDeviceId: alice.deviceId,
      keyEpoch: 1,
      messageId: "msg-1",
    });

    const forged = { ...envelope, ciphertext: new Uint8Array([1, 2, 3]) };

    await expect(
      service.open({
        envelope: forged,
        recipientX25519PrivateKey: bob.x25519PrivateKey,
        senderX25519PublicKey: alice.x25519PublicKey,
        senderEd25519PublicKey: alice.ed25519PublicKey,
        keyEpoch: 1,
      }),
    ).rejects.toBeInstanceOf(InvalidSignatureError);
  });

  it("rejects an unsupported protocol version", async () => {
    const service = new EnvelopeService();
    expect(() =>
      service.validateEnvelope(
        {
          protocolVersion: 99,
          conversationId: "c",
          senderUserId: "u",
          senderDeviceId: "d",
          messageId: "m",
          keyEpoch: 1,
          nonce: new Uint8Array(24),
          ciphertext: new Uint8Array([1]),
        },
        { maxBytes: 1024 },
      ),
    ).toThrow(UnsupportedVersionError);
  });
});

describe("E2EE replay protection", () => {
  it("rejects duplicate message delivery", async () => {
    const guard = new ReplayGuard();
    expect(guard.accept("dev-1", "msg-1")).toBe(true);
    expect(guard.accept("dev-1", "msg-1")).toBe(false); // duplicate
    expect(guard.accept("dev-1", "msg-2")).toBe(true);
    // A different device can reuse a message id.
    expect(guard.accept("dev-2", "msg-1")).toBe(true);
  });
});

describe("E2EE device identity and key directory", () => {
  it("device identity manager creates keys and a signed record", async () => {
    const manager = new MemoryDeviceIdentityManager("acct-1");
    const identity = await manager.initialize();

    expect(identity.x25519PublicKey.length).toBe(32);
    expect(identity.x25519PrivateKey.length).toBe(32);
    expect(identity.ed25519PublicKey.length).toBe(32);
    expect(identity.ed25519PrivateKey.length).toBe(64);

    const record = await manager.getPublicDeviceRecord();
    expect(record.accountId).toBe("acct-1");
    expect(record.deviceId).toBe(identity.deviceId);

    const trust = await manager.verifyDeviceRecord(record);
    expect(trust.trust).toBe("pending"); // not yet approved
    await manager.approveDevice(identity.deviceId);
    const trusted = await manager.verifyDeviceRecord(record);
    expect(trusted.trust).toBe("trusted");

    await manager.revokeDevice(identity.deviceId);
    const revoked = await manager.verifyDeviceRecord(record);
    expect(revoked.trust).toBe("revoked");
  });

  it("key directory publishes and fetches records", async () => {
    const directory = new MemoryKeyDirectory();
    const manager = new MemoryDeviceIdentityManager("acct-1");
    const identity = await manager.initialize();
    const record = await manager.getPublicDeviceRecord();

    await directory.publishRecord(record);
    const fetched = await directory.fetchRecord("acct-1", identity.deviceId);
    expect(fetched?.deviceId).toBe(identity.deviceId);
    expect(fetched?.x25519PublicKey).toBe(record.x25519PublicKey);

    const all = await directory.fetchAccountRecords("acct-1");
    expect(all).toHaveLength(1);

    await directory.revokeRecord("acct-1", identity.deviceId);
    expect(await directory.fetchRecord("acct-1", identity.deviceId)).toBeNull();
  });

  it("rejects a key-substitution attempt (record does not match)", async () => {
    const manager = new MemoryDeviceIdentityManager("acct-1");
    const identity = await manager.initialize();
    const record = await manager.getPublicDeviceRecord();

    // Tamper with the public key in the record without re-signing.
    const forged = {
      ...record,
      x25519PublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", // base64 of 32 zero bytes
    };

    const trust = await manager.verifyDeviceRecord(forged);
    expect(trust.trust).toBe("unknown");
  });
});

describe("E2EE fail-closed conditions", () => {
  const alice = generateDeviceKeys();
  const bob = generateDeviceKeys();
  const service = new EnvelopeService({
    allowedEpochs: new Set([1]),
    revokedDevices: new Set([alice.deviceId]),
  });

  let envelope: any = null;

  beforeEach(async () => {
    envelope = await service.seal({
      plaintext: new TextEncoder().encode("payload"),
      recipientPublicKey: bob.x25519PublicKey,
      senderX25519KeyPair: {
        publicKey: alice.x25519PublicKey,
        privateKey: alice.x25519PrivateKey,
      },
      senderEd25519KeyPair: {
        publicKey: alice.ed25519PublicKey,
        privateKey: alice.ed25519PrivateKey,
      },
      conversationId: "conv-1",
      senderUserId: "alice",
      senderDeviceId: alice.deviceId,
      keyEpoch: 1,
      messageId: "msg-1",
    });
  });

  it("rejects a revoked sender device", async () => {
    await expect(
      service.open({
        envelope,
        recipientX25519PrivateKey: bob.x25519PrivateKey,
        senderX25519PublicKey: alice.x25519PublicKey,
        senderEd25519PublicKey: alice.ed25519PublicKey,
        keyEpoch: 1,
      }),
    ).rejects.toBeInstanceOf(RevokedDeviceError);
  });

  it("rejects an unknown key epoch", async () => {
    const service2 = new EnvelopeService({ allowedEpochs: new Set([1]) });
    const env = await service2.seal({
      plaintext: new TextEncoder().encode("p"),
      recipientPublicKey: bob.x25519PublicKey,
      senderX25519KeyPair: {
        publicKey: alice.x25519PublicKey,
        privateKey: alice.x25519PrivateKey,
      },
      senderEd25519KeyPair: {
        publicKey: alice.ed25519PublicKey,
        privateKey: alice.ed25519PrivateKey,
      },
      conversationId: "conv-1",
      senderUserId: "alice",
      senderDeviceId: alice.deviceId,
      keyEpoch: 99,
      messageId: "msg-2",
    });

    await expect(
      service2.open({
        envelope: env,
        recipientX25519PrivateKey: bob.x25519PrivateKey,
        senderX25519PublicKey: alice.x25519PublicKey,
        senderEd25519PublicKey: alice.ed25519PublicKey,
        keyEpoch: 1,
      }),
    ).rejects.toBeInstanceOf(UnknownEpochError);
  });
});

describe("E2EE envelope schema validation", () => {
  const service = new EnvelopeService();

  const validBase = {
    protocolVersion: 1,
    conversationId: "c",
    senderUserId: "u",
    senderDeviceId: "d",
    messageId: "m",
    keyEpoch: 1,
    nonce: new Uint8Array(24),
    ciphertext: new Uint8Array([1, 2, 3]),
    signature: new Uint8Array(64),
  };

  it("accepts a well-formed envelope", () => {
    expect(() =>
      service.validateEnvelope({ ...validBase }, { maxBytes: 1024 }),
    ).not.toThrow();
  });

  it("rejects a missing required field", () => {
    const { senderUserId, ...rest } = validBase;
    expect(() => service.validateEnvelope(rest, { maxBytes: 1024 })).toThrow(
      InvalidEnvelopeError,
    );
  });

  it("rejects a wrong nonce length", () => {
    expect(() =>
      service.validateEnvelope(
        { ...validBase, nonce: new Uint8Array(16) },
        { maxBytes: 1024 },
      ),
    ).toThrow(InvalidEnvelopeError);
  });

  it("rejects an oversized envelope", () => {
    const big = {
      ...validBase,
      ciphertext: new Uint8Array(70 * 1024),
    };
    expect(() => service.validateEnvelope(big, { maxBytes: 64 * 1024 })).toThrow(
      EnvelopeTooLargeError,
    );
  });

  it("rejects an empty ciphertext", () => {
    expect(() =>
      service.validateEnvelope({ ...validBase, ciphertext: new Uint8Array(0) }, { maxBytes: 1024 }),
    ).toThrow(InvalidEnvelopeError);
  });
});

describe("E2EE Core Hub integration — routes ciphertext without decrypting", () => {
  it("sendEnvelope routes an opaque envelope to room members", async () => {
    const hub = makeHubWithE2EE();
    const aliceTransport = await aliceConnection(hub);
    const bobTransport = new FakeTransport("c-bob");
    await hub.connect(bobTransport, "cred-bob");

    await hub.joinRoom("c-alice", "room-1");
    await hub.joinRoom("c-bob", "room-1");

    const alice = generateDeviceKeys();
    const envelope = await new EnvelopeService().seal({
      plaintext: new TextEncoder().encode("opaque"),
      recipientPublicKey: alice.x25519PublicKey,
      senderX25519KeyPair: {
        publicKey: alice.x25519PublicKey,
        privateKey: alice.x25519PrivateKey,
      },
      senderEd25519KeyPair: {
        publicKey: alice.ed25519PublicKey,
        privateKey: alice.ed25519PrivateKey,
      },
      conversationId: "room-1",
      senderUserId: "alice",
      senderDeviceId: alice.deviceId,
      keyEpoch: 1,
      messageId: "msg-1",
    });

    const result = await hub.sendEnvelope("c-alice", envelope);
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);

    expect(bobTransport.sent.length).toBe(1);
    const received = bobTransport.sent[0];
    expect(received.data).toBeInstanceOf(Uint8Array);
    const wire = new TextDecoder().decode(received.data);
    expect(wire).not.toContain("opaque");
  });

  it("sendEnvelope requires authentication", async () => {
    const hub = makeHubWithE2EE();
    const envelope = { protocolVersion: 1, conversationId: "r", senderUserId: "u", senderDeviceId: "d", messageId: "m", keyEpoch: 1, nonce: new Uint8Array(24), ciphertext: new Uint8Array([1]) };
    await expect(hub.sendEnvelope("unknown", envelope as any)).rejects.toThrow();
  });

  it("sendEnvelope is rejected when the sender userId does not match the authenticated identity", async () => {
    const hub = makeHubWithE2EE();
    await aliceConnection(hub);
    const envelope = { protocolVersion: 1, conversationId: "r", senderUserId: "eve", senderDeviceId: "d", messageId: "m", keyEpoch: 1, nonce: new Uint8Array(24), ciphertext: new Uint8Array([1]) };
    await expect(hub.sendEnvelope("c-alice", envelope as any)).rejects.toThrow();
  });

  it("sendEnvelope is denied by the authorize hook", async () => {
    const hub = makeHubWithE2EE({
      authorize: () => false,
    });
    await aliceConnection(hub);
    const envelope = { protocolVersion: 1, conversationId: "r", senderUserId: "alice", senderDeviceId: "d", messageId: "m", keyEpoch: 1, nonce: new Uint8Array(24), ciphertext: new Uint8Array([1]), signature: new Uint8Array(64) };
    await expect(hub.sendEnvelope("c-alice", envelope as any)).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("sendEnvelope without an envelope service throws", async () => {
    const hub = new Hub({
      authProvider: makeAuthProvider({ userId: "alice", tenantId: "tenant-a" }),
    });
    await aliceConnection(hub);
    const envelope = { protocolVersion: 1, conversationId: "r", senderUserId: "alice", senderDeviceId: "d", messageId: "m", keyEpoch: 1, nonce: new Uint8Array(24), ciphertext: new Uint8Array([1]), signature: new Uint8Array(64) };
    await expect(hub.sendEnvelope("c-alice", envelope as any)).rejects.toThrow();
  });
});
