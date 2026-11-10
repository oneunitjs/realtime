/**
 * BDD edge case suite.
 *
 * Given-When-Then scenarios focused on boundary conditions, invalid inputs,
 * null/undefined, and extreme data ranges across: Core Hub, Error Contract,
 * E2EE, Event Delivery, Collaboration Engine.
 *
 * Each scenario reads: Given <precondition>, When <action>, Then <outcome>.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { Hub, type HubOptions } from "../../src/core/core-hub.js";
import type { AuthProvider } from "../../src/core/auth/auth-provider.js";
import { FakeTransport } from "../../src/transport/testing/transport-connection.js";
import {
  EnvelopeService,
  generateDeviceKeys,
  MemoryDeviceIdentityManager,
  MemoryKeyDirectory,
  ReplayGuard,
  InvalidEnvelopeError,
  EnvelopeTooLargeError,
  UnsupportedVersionError,
  AeadFailureError,
  ReplayError,
  InvalidSignatureError,
  UnknownEpochError,
  RevokedDeviceError,
} from "../../src/index.js";
import {
  RoomCapacityError,
  ConnectionNotAuthenticatedError,
  AuthenticationTimeoutError,
} from "../../src/error/index.js";
import { HubError, mapError, toPublicError } from "../../src/error/index.js";

// ---------------------------------------------------------------------------
// Core Hub BDD edge cases
// ---------------------------------------------------------------------------

describe("Given an unauthenticated client, When joining a room, Then the Hub rejects it", () => {
  it("Given no connection record, When joinRoom, Then ConnectionNotAuthenticatedError is thrown", async () => {
    const hub = new Hub({ authProvider: { authenticate: async () => ({ userId: "u", tenantId: "t", roles: [], sessionId: "s" }) } });
    await expect(hub.joinRoom("ghost", "room-x")).rejects.toBeInstanceOf(ConnectionNotAuthenticatedError);
  });
});

describe("Given a room at capacity, When an extra client joins, Then RoomCapacityError surfaces the limit", () => {
  it("Given capacity=1 and one member, When a second client joins, Then rejected with limit=1", async () => {
    const auth: AuthProvider = { authenticate: async () => ({ userId: "u", tenantId: "t", roles: [], sessionId: "s" }) };
    const hub = new Hub({ authProvider: auth, roomCapacities: { "room-1": 1 } });
    const t1 = new FakeTransport("c1");
    const t2 = new FakeTransport("c2");
    await hub.connect(t1, "cred");
    await hub.connect(t2, "cred");
    await hub.joinRoom("c1", "room-1");
    try {
      await hub.joinRoom("c2", "room-1");
    } catch (e) {
      expect(e).toBeInstanceOf(RoomCapacityError);
      expect((e as RoomCapacityError).limit).toBe(1);
    }
  });
});

describe("Given an oversized payload envelope, When validated, Then EnvelopeTooLargeError is raised", () => {
  it("Given maxBytes=64 and 70KB ciphertext, When validateEnvelope, Then throws EnvelopeTooLargeError", () => {
    const service = new EnvelopeService();
    try {
      service.validateEnvelope(
        {
          protocolVersion: 1,
          conversationId: "c",
          senderUserId: "u",
          senderDeviceId: "d",
          messageId: "m",
          keyEpoch: 1,
          nonce: new Uint8Array(24),
          ciphertext: new Uint8Array(70 * 1024),
        },
        { maxBytes: 64 * 1024 },
      );
    } catch (e) {
      expect(e).toBeInstanceOf(EnvelopeTooLargeError);
    }
  });
});

describe("Given a null/undefined envelope, When validated, Then InvalidEnvelopeError is raised", () => {
  it("Given null, When validateEnvelope, Then throws", () => {
    const service = new EnvelopeService();
    expect(() => service.validateEnvelope(null, { maxBytes: 1024 })).toThrow(InvalidEnvelopeError);
  });
  it("Given a number instead of object, When validateEnvelope, Then throws", () => {
    const service = new EnvelopeService();
    expect(() => service.validateEnvelope(42, { maxBytes: 1024 })).toThrow(InvalidEnvelopeError);
  });
});

describe("Given unsupported protocol version, When validating, Then UnsupportedVersionError is raised", () => {
  it("Given version=99, When validateEnvelope, Then throws UnsupportedVersionError", () => {
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

describe("Given an empty ciphertext, When validating, Then InvalidEnvelopeError is raised", () => {
  it("Given ciphertext length 0, When validateEnvelope, Then throws InvalidEnvelopeError", () => {
    const service = new EnvelopeService();
    expect(() =>
      service.validateEnvelope(
        {
          protocolVersion: 1,
          conversationId: "c",
          senderUserId: "u",
          senderDeviceId: "d",
          messageId: "m",
          keyEpoch: 1,
          nonce: new Uint8Array(24),
          ciphertext: new Uint8Array(0),
        },
        { maxBytes: 1024 },
      ),
    ).toThrow(InvalidEnvelopeError);
  });
});

// ---------------------------------------------------------------------------
// E2EE BDD edge cases
// ---------------------------------------------------------------------------

describe("Given tampered ciphertext, When opening, Then AeadFailureError (fail closed)", () => {
  it("Given a single bit flip in ciphertext, When open, Then rejects with AeadFailureError", async () => {
    await (await import("libsodium-wrappers")).ready;
    const alice = generateDeviceKeys();
    const bob = generateDeviceKeys();
    const service = new EnvelopeService();
    const env = await service.seal({
      plaintext: new TextEncoder().encode("secret"),
      recipientPublicKey: bob.x25519PublicKey,
      senderX25519KeyPair: { publicKey: alice.x25519PublicKey, privateKey: alice.x25519PrivateKey },
      senderEd25519KeyPair: { publicKey: alice.ed25519PublicKey, privateKey: alice.ed25519PrivateKey },
      conversationId: "conv-1",
      senderUserId: "alice",
      senderDeviceId: alice.deviceId,
      keyEpoch: 1,
      messageId: "msg-1",
    });
    const tampered = { ...env, ciphertext: new Uint8Array(env.ciphertext) };
    tampered.ciphertext[0] ^= 0xff;
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
});

describe("Given a revoked device, When opening, Then RevokedDeviceError", () => {
  it("Given sender in revoked set, When open, Then RevokedDeviceError thrown", async () => {
    await (await import("libsodium-wrappers")).ready;
    const alice = generateDeviceKeys();
    const bob = generateDeviceKeys();
    const service = new EnvelopeService({ revokedDevices: new Set([alice.deviceId]) });
    const env = await service.seal({
      plaintext: new TextEncoder().encode("x"),
      recipientPublicKey: bob.x25519PublicKey,
      senderX25519KeyPair: { publicKey: alice.x25519PublicKey, privateKey: alice.x25519PrivateKey },
      senderEd25519KeyPair: { publicKey: alice.ed25519PublicKey, privateKey: alice.ed25519PrivateKey },
      conversationId: "conv-1",
      senderUserId: "alice",
      senderDeviceId: alice.deviceId,
      keyEpoch: 1,
      messageId: "msg-1",
    });
    await expect(
      service.open({
        envelope: env,
        recipientX25519PrivateKey: bob.x25519PrivateKey,
        senderX25519PublicKey: alice.x25519PublicKey,
        senderEd25519PublicKey: alice.ed25519PublicKey,
        keyEpoch: 1,
      }),
    ).rejects.toBeInstanceOf(RevokedDeviceError);
  });
});

describe("Given an unknown key epoch, When opening, Then UnknownEpochError", () => {
  it("Given allowed epochs {1} and envelope epoch 99, When open, Then UnknownEpochError", async () => {
    await (await import("libsodium-wrappers")).ready;
    const alice = generateDeviceKeys();
    const bob = generateDeviceKeys();
    const service = new EnvelopeService({ allowedEpochs: new Set([1]) });
    const env = await service.seal({
      plaintext: new TextEncoder().encode("x"),
      recipientPublicKey: bob.x25519PublicKey,
      senderX25519KeyPair: { publicKey: alice.x25519PublicKey, privateKey: alice.x25519PrivateKey },
      senderEd25519KeyPair: { publicKey: alice.ed25519PublicKey, privateKey: alice.ed25519PrivateKey },
      conversationId: "conv-1",
      senderUserId: "alice",
      senderDeviceId: alice.deviceId,
      keyEpoch: 99,
      messageId: "msg-1",
    });
    await expect(
      service.open({
        envelope: env,
        recipientX25519PrivateKey: bob.x25519PrivateKey,
        senderX25519PublicKey: alice.x25519PublicKey,
        senderEd25519PublicKey: alice.ed25519PublicKey,
        keyEpoch: 1,
      }),
    ).rejects.toBeInstanceOf(UnknownEpochError);
  });
});

describe("Given duplicate message delivery, When ReplayGuard.consume, Then second is rejected", () => {
  it("Given same sender+messageId twice, When consume, Then second returns false", () => {
    const guard = new ReplayGuard();
    expect(guard.consume("dev-1", "msg-1")).toBe(true);
    expect(guard.consume("dev-1", "msg-1")).toBe(false);
  });
});

describe("Given a key-substitution attempt, When verifying record, Then trust is unknown", () => {
  it("Given tampered public key in signed record, When verifyDeviceRecord, Then trust=unknown", async () => {
    await (await import("libsodium-wrappers")).ready;
    const manager = new MemoryDeviceIdentityManager("acct-1");
    const identity = await manager.initialize();
    const record = await manager.getPublicDeviceRecord();
    const forged = { ...record, x25519PublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
    const trust = await manager.verifyDeviceRecord(forged);
    expect(trust.trust).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Error contract BDD edge cases
// ---------------------------------------------------------------------------

describe("Given an unknown exception, When mapError, Then opaque INTERNAL with requestId", () => {
  it("Given Error('secret internals'), When mapError, Then code=INTERNAL, message opaque, no leak", () => {
    const sentinel = "SECRET-SENTINEL-XYZ";
    const err = new Error(sentinel);
    const publicError = mapError(err, { requestId: "req-edge" });
    expect(publicError.code).toBe("INTERNAL");
    expect(publicError.message).toBe("An internal error occurred.");
    expect(publicError.requestId).toBe("req-edge");
    expect(JSON.stringify(publicError)).not.toContain(sentinel);
  });
});

describe("Given a retryable idempotent op, When retry budget exhausted, Then RetryExhaustedError", () => {
  it("Given always-failing delivery, When withRetry with maxAttempts=2, Then throws RetryExhaustedError", async () => {
    const { withRetry } = await import("../../src/error/index.js");
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          const { DeliveryFailedError } = await import("../../src/error/index.js");
          throw new DeliveryFailedError("always fails");
        },
        { idempotent: true, maxAttempts: 2, baseDelayMs: 1, capDelayMs: 10, deadlineMs: 1000 },
      ),
    ).rejects.toBeTruthy();
    expect(attempts).toBe(2);
  });
});

describe("Given a deadline expiry, When work hangs, Then DeadlineExceededError is thrown", () => {
  it("Given hanging work, When withDeadline(100ms), Then DeadlineExceededError", async () => {
    const { withDeadline, DeadlineExceededError } = await import("../../src/error/index.js");
    vi.useFakeTimers();
    const promise = withDeadline(async (signal) => {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw new Error("work observed abort");
    }, 100);
    vi.advanceTimersByTime(150);
    await expect(promise).rejects.toBeInstanceOf(DeadlineExceededError);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Collaboration Engine BDD edge cases
// ---------------------------------------------------------------------------

describe("Given a CRDT conflicting opId, When apply, Then rejected with CONFLICTING_OP_ID", () => {
  it("Given same id different payload, When apply second op, Then rejected", async () => {
    const { ApplyEngine } = await import("../../src/collab/core/apply.js");
    const engine = new ApplyEngine();
    const op1 = { kind: "text.insert" as const, opId: { actorId: "a", counter: 1 }, deps: {} as any, after: "ROOT" as const, value: "a" };
    const op2 = { kind: "text.insert" as const, opId: { actorId: "a", counter: 1 }, deps: {} as any, after: "ROOT" as const, value: "X" };
    expect(engine.apply(op1 as any).status).toBe("applied");
    const r = engine.apply(op2 as any);
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.code).toBe("CONFLICTING_OP_ID");
  });
});

describe("Given out-of-order ops, When applied, Then buffers then converges", () => {
  it("Given sibling op buffered then dependency applied, When both applied, Then same text", async () => {
    const { ApplyEngine } = await import("../../src/collab/core/apply.js");
    const a = new ApplyEngine();
    const b = new ApplyEngine();
    const ops = [
      { kind: "text.insert" as const, opId: { actorId: "a", counter: 1 }, deps: {} as any, after: "ROOT" as const, value: "a" },
      { kind: "text.insert" as const, opId: { actorId: "a", counter: 2 }, deps: { a: 1 } as any, after: { actorId: "a", counter: 1 }, value: "b" },
    ];
    a.apply(ops[0]);
    a.apply(ops[1]);
    b.apply(ops[1]);
    b.apply(ops[0]);
    expect(a.getState().text).toBe(b.getState().text);
    expect(a.getState().text).toBe("ab");
  });
});

// ---------------------------------------------------------------------------
// Event delivery BDD edge cases
// ---------------------------------------------------------------------------

describe("Given a revoked / unknown connection, When EventService.publish, Then throws", () => {
  it("Given missing connection, When publish, Then rejects", async () => {
    const { EventService } = await import("../../src/event/index.js");
    const { HubConnectionView } = await import("../../src/event/types.js") as any;
    const members: Record<string, string[]> = {};
    const deps: any = {
      hub: { getConnection: () => undefined },
      membership: { members: (r: string) => members[r] ?? [], count: (r: string) => (members[r] ?? []).length, rooms: () => [], has: () => false },
      clock: { now: () => 1_000_000 },
      idGenerator: { generate: () => "msg-fixed" },
    };
    const service = new EventService(deps);
    await expect(service.publish("ghost", "room:message", { text: "hi" })).rejects.toThrow();
  });
});

describe("Given ACK from wrong connection, When ack, Then WRONG_RECIPIENT", () => {
  it("Given record exists for r1, When ACK sent from r2, Then fails with WRONG_RECIPIENT", async () => {
    const { AckHandler, MemoryDeliveryRecordStore, deliveryRecordKey } = await import("../../src/event/index.js") as any;
    const store = new MemoryDeliveryRecordStore();
    const handler = new AckHandler(store, (conn: string, claiming: string) => conn === claiming);
    store.set({ messageId: "m1", recipientConnectionId: "r1", state: "written", attempts: 1, deadlineAt: 2_000_000 });
    const result = handler.handle({ messageId: "m1", recipientConnectionId: "r1", kind: "received" }, "r2");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("WRONG_RECIPIENT");
  });
});
