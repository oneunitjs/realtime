import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hub, type HubOptions } from "../../src/core/core-hub.js";
import type { AuthProvider } from "../../src/core/auth/auth-provider.js";
import type { Principal } from "../../src/core/connection/connection.types.js";
import { FakeTransport } from "../../src/transport/testing/transport-connection.js";
import { EnvelopeService, generateDeviceKeys, InvalidEnvelopeError, UnsupportedVersionError } from "../../src/e2ee/index.js";
import { RoomNamespaceRouter } from "../../src/room-namespace/router.js";
import type {
  NamespaceRecord,
  RoomRecord,
  RoomNamespaceStore,
  Membership,
} from "../../src/room-namespace/types.js";
import { encodeRoomKey } from "../../src/room-namespace/room-key.js";
// Collaboration imports (top-level, required by ES modules)
import type {
  CrdtOperation,
  ElementId,
  TextInsertOperation,
  VectorClock,
} from "../../src/collab/core/types.js";
import { ApplyEngine } from "../../src/collab/core/apply.js";
import {
  encodeOperation,
  validateOperation,
  validateSchemaVersion,
} from "../../src/collab/core/encode.js";
import { decodeElementId } from "../../src/collab/core/types.js";

await (await import("libsodium-wrappers")).ready;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function principalFor(userId: string, tenantId: string): Principal {
  return { userId, tenantId, roles: ["user"], sessionId: "s1" };
}

function makeAuthProvider(options: {
  principal?: Principal;
  byCredential?: Record<string, Principal>;
} = {}): AuthProvider {
  return {
    authenticate: async (credential, { signal }) => {
      signal.throwIfAborted?.();
      if (options.byCredential && credential) {
        const p = options.byCredential[credential];
        if (p) return p;
        throw new Error("unknown credential");
      }
      return options.principal ?? principalFor("alice", "tenant-a");
    },
  };
}

function makeHub(options: {
  authProvider?: AuthProvider;
  authorize?: (
    action: string,
    principal: Principal,
    resourceId?: string,
    tenantId?: string
  ) => boolean;
  envelopeService?: import("../../src/e2ee/envelope.js").EnvelopeService;
} = {}): Hub {
  return new Hub({
    authProvider: options.authProvider ?? makeAuthProvider(),
    authorize: options.authorize ?? (() => true),
    envelopeService: options.envelopeService,
  } as HubOptions);
}

async function connectClient(
  hub: Hub,
  transportId: string,
  userId = "alice",
  tenantId = "tenant-a",
  credential = "cred"
) {
  const transport = new FakeTransport(transportId);
  await hub.connect(transport, credential);
  return transport;
}

function collectFrames(transport: FakeTransport): unknown[] {
  const frames: unknown[] = [];
  transport.onSend((message) => {
    frames.push(message);
  });
  return frames;
}

// ---------------------------------------------------------------------------
// Test store for room-namespace integration
// ---------------------------------------------------------------------------

class IntegrationStore implements RoomNamespaceStore {
  private namespaces = new Map<string, NamespaceRecord>();
  private rooms = new Map<string, RoomRecord>();
  private memberships = new Map<string, Map<string, { userId: string; joinedAt: number }>>();

  getNamespace(tenantId: string, namespaceId: string): Promise<NamespaceRecord | null> {
    return Promise.resolve(this.namespaces.get(`${tenantId}:${namespaceId}`) ?? null);
  }
  createNamespace(record: NamespaceRecord): Promise<void> {
    this.namespaces.set(`${record.tenantId}:${record.namespaceId}`, record);
    return Promise.resolve();
  }
  deleteNamespace(tenantId: string, namespaceId: string): Promise<void> {
    this.namespaces.delete(`${tenantId}:${namespaceId}`);
    return Promise.resolve();
  }
  listNamespaces(tenantId: string): Promise<NamespaceRecord[]> {
    return Promise.resolve(
      [...this.namespaces.values()].filter((n) => n.tenantId === tenantId),
    );
  }

  getRoom(roomKey: string): Promise<RoomRecord | null> {
    return Promise.resolve(this.rooms.get(roomKey) ?? null);
  }
  createRoom(record: RoomRecord): Promise<void> {
    this.rooms.set(encodeRoomKey(record.tenantId, record.namespaceId, record.roomId), record);
    return Promise.resolve();
  }
  deleteRoom(roomKey: string): Promise<void> {
    this.rooms.delete(roomKey);
    return Promise.resolve();
  }
  listRooms(tenantId: string, namespaceId: string): Promise<RoomRecord[]> {
    return Promise.resolve(
      [...this.rooms.values()].filter((r) => r.tenantId === tenantId && r.namespaceId === namespaceId),
    );
  }

  getMembership(roomKey: string, connectionId: string): Promise<Membership | null> {
    const byConn = this.memberships.get(roomKey);
    const entry = byConn?.get(connectionId);
    if (!entry) return Promise.resolve(null);
    return Promise.resolve({ roomKey, connectionId, userId: entry.userId, joinedAt: entry.joinedAt });
  }
  getMembers(roomKey: string): Promise<Membership[]> {
    const byConn = this.memberships.get(roomKey) ?? new Map();
    return Promise.resolve(
      [...byConn.entries()].map(([connectionId, m]) => ({
        roomKey,
        connectionId,
        userId: m.userId,
        joinedAt: m.joinedAt,
      })),
    );
  }
  getMemberCount(roomKey: string): Promise<number> {
    return Promise.resolve((this.memberships.get(roomKey) ?? new Map()).size);
  }
  getConnectionsForUser(userId: string, tenantId: string): Promise<string[]> {
    const result: string[] = [];
    for (const byConn of this.memberships.values()) {
      for (const [connectionId, m] of byConn) {
        if (m.userId === userId) result.push(connectionId);
      }
    }
    return Promise.resolve(result);
  }
  addMembership(membership: { roomKey: string; connectionId: string; userId: string; joinedAt: number }): Promise<void> {
    let byConn = this.memberships.get(membership.roomKey);
    if (!byConn) {
      byConn = new Map();
      this.memberships.set(membership.roomKey, byConn);
    }
    byConn.set(membership.connectionId, { userId: membership.userId, joinedAt: membership.joinedAt });
    return Promise.resolve();
  }
  removeMembership(roomKey: string, connectionId: string): Promise<void> {
    this.memberships.get(roomKey)?.delete(connectionId);
    return Promise.resolve();
  }
  removeAllMembershipsForConnection(connectionId: string): Promise<void> {
    for (const byConn of this.memberships.values()) {
      byConn.delete(connectionId);
    }
    return Promise.resolve();
  }
  getRoomsForConnection(connectionId: string): Promise<string[]> {
    const result: string[] = [];
    for (const [roomKey, byConn] of this.memberships) {
      if (byConn.has(connectionId)) result.push(roomKey);
    }
    return Promise.resolve(result);
  }
}

// ---------------------------------------------------------------------------
// Integration: Hub + rooms + events + presence + E2EE
// ---------------------------------------------------------------------------

describe("integration — Hub + rooms + events + presence + E2EE", () => {
  let hub: Hub;
  let aliceTransport: FakeTransport;
  let bobTransport: FakeTransport;
  let aliceFrames: unknown[];
  let bobFrames: unknown[];
  let envelopeService: EnvelopeService;

  beforeEach(async () => {
    envelopeService = new EnvelopeService({ allowedEpochs: new Set([1, 2]) });
    hub = makeHub({ envelopeService });

    aliceTransport = await connectClient(hub, "c-alice", "alice", "tenant-a", "cred-alice");
    bobTransport = await connectClient(hub, "c-bob", "bob", "tenant-a", "cred-bob");

    aliceFrames = collectFrames(aliceTransport);
    bobFrames = collectFrames(bobTransport);

    await hub.joinRoom("c-alice", "room-1");
    await hub.joinRoom("c-bob", "room-1");
  });

  afterEach(() => {
    hub.close();
  });

  it("publishes a room event that the other member receives", async () => {
    const result = await hub.publish("c-alice", {
      type: "chat:message",
      roomId: "room-1",
      payload: { text: "hello" },
    });

    expect(result.status).toBe("delivered");
    if (result.status === "delivered") {
      expect(result.recipientCount).toBe(1);
    }

    // Allow async delivery to flush.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(bobFrames.length).toBe(1);
    const received = bobFrames[0] as { data: Uint8Array };
    const decoded = new TextDecoder().decode(received.data);
    const parsed = JSON.parse(decoded);
    expect(parsed.type).toBe("chat:message");
    expect(parsed.payload).toEqual({ text: "hello" });
  });

  it("routes an opaque E2EE envelope to room members without decrypting", async () => {
    const aliceKeys = generateDeviceKeys();
    const bobKeys = generateDeviceKeys();

    const envelope = await envelopeService.seal({
      plaintext: new TextEncoder().encode("secret document"),
      recipientPublicKey: bobKeys.x25519PublicKey,
      senderX25519KeyPair: {
        publicKey: aliceKeys.x25519PublicKey,
        privateKey: aliceKeys.x25519PrivateKey,
      },
      senderEd25519KeyPair: {
        publicKey: aliceKeys.ed25519PublicKey,
        privateKey: aliceKeys.ed25519PrivateKey,
      },
      conversationId: "room-1",
      senderUserId: "alice",
      senderDeviceId: aliceKeys.deviceId,
      keyEpoch: 1,
      messageId: "msg-1",
    });

    const result = await hub.sendEnvelope("c-alice", envelope);
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(bobFrames.length).toBe(1);
    const received = bobFrames[0] as { data: Uint8Array };
    const wire = JSON.stringify(received);
    // Plaintext must never appear on the wire.
    expect(wire).not.toContain("secret document");
    // But the opaque envelope is present.
    expect(received.data).toBeInstanceOf(Uint8Array);
    expect(received.data.length).toBeGreaterThan(0);
  });

  it("rejects a malformed envelope (fail closed, no decryption)", async () => {
    const badEnvelope = {
      protocolVersion: 99, // unsupported
      conversationId: "room-1",
      senderUserId: "alice",
      senderDeviceId: "dev-1",
      messageId: "msg-bad",
      keyEpoch: 1,
      nonce: new Uint8Array(24),
      ciphertext: new Uint8Array([1]),
    } as never;

    await expect(hub.sendEnvelope("c-alice", badEnvelope)).rejects.toThrow(
      UnsupportedVersionError,
    );
  });

  it("binds envelope sender identity to authenticated principal", async () => {
    const aliceKeys = generateDeviceKeys();
    const bobKeys = generateDeviceKeys();

    // Envelope claims sender is "eve" but authenticated user is "alice".
    const envelope = await new EnvelopeService().seal({
      plaintext: new TextEncoder().encode("x"),
      recipientPublicKey: bobKeys.x25519PublicKey,
      senderX25519KeyPair: {
        publicKey: aliceKeys.x25519PublicKey,
        privateKey: aliceKeys.x25519PrivateKey,
      },
      senderEd25519KeyPair: {
        publicKey: aliceKeys.ed25519PublicKey,
        privateKey: aliceKeys.ed25519PrivateKey,
      },
      conversationId: "room-1",
      senderUserId: "eve", // mismatch!
      senderDeviceId: aliceKeys.deviceId,
      keyEpoch: 1,
      messageId: "msg-1",
    });

    await expect(hub.sendEnvelope("c-alice", envelope)).rejects.toThrow();
  });

  it("cleans up room membership and presence on disconnect", async () => {
    await hub.disconnect("c-alice", "client disconnect");

    // Alice's transport is closed.
    expect(aliceTransport.state).toBe("closed");

    // Bob is still online and can join another room.
    await hub.joinRoom("c-bob", "room-2");
    const bobMembers = await hub["membership"].members("room-2");
    expect(bobMembers).toContain("c-bob");

    // Alice is no longer in room-1.
    const aliceRooms = await hub["membership"].rooms("c-alice");
    expect(aliceRooms).not.toContain("room-1");
  });

  it("rejects connecting with an unknown credential", async () => {
    const strictAuth = makeAuthProvider({
      byCredential: { "good-cred": principalFor("alice", "tenant-a") },
    });
    const strictHub = makeHub({ authProvider: strictAuth });

    const rogueTransport = new FakeTransport("c-rogue");
    await expect(
      strictHub.connect(rogueTransport, "bad-cred"),
    ).rejects.toThrow();
    strictHub.close();
  });
});

// ---------------------------------------------------------------------------
// Integration: E2EE key epoch rotation + room rekey
// ---------------------------------------------------------------------------

describe("integration — E2EE key epoch rotation + room rekey", () => {
  let aliceKeys: ReturnType<typeof generateDeviceKeys>;
  let bobKeys: ReturnType<typeof generateDeviceKeys>;

  beforeEach(() => {
    aliceKeys = generateDeviceKeys();
    bobKeys = generateDeviceKeys();
  });

  it("client-side open rejects an envelope sealed under a stale key epoch", async () => {
    // Sender seals under epoch 1.
    const staleService = new EnvelopeService({ allowedEpochs: new Set([1]) });
    const envelope = await staleService.seal({
      plaintext: new TextEncoder().encode("stale payload"),
      recipientPublicKey: bobKeys.x25519PublicKey,
      senderX25519KeyPair: {
        publicKey: aliceKeys.x25519PublicKey,
        privateKey: aliceKeys.x25519PrivateKey,
      },
      senderEd25519KeyPair: {
        publicKey: aliceKeys.ed25519PublicKey,
        privateKey: aliceKeys.ed25519PrivateKey,
      },
      conversationId: "room-1",
      senderUserId: "alice",
      senderDeviceId: aliceKeys.deviceId,
      keyEpoch: 1,
      messageId: "msg-stale",
    });

    // Recipient's service only allows epoch 2 → open fails.
    const recipientService = new EnvelopeService({ allowedEpochs: new Set([2]) });

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

  it("client-side open accepts an envelope sealed under the current key epoch", async () => {
    const service = new EnvelopeService({ allowedEpochs: new Set([2]) });
    const envelope = await service.seal({
      plaintext: new TextEncoder().encode("current payload"),
      recipientPublicKey: bobKeys.x25519PublicKey,
      senderX25519KeyPair: {
        publicKey: aliceKeys.x25519PublicKey,
        privateKey: aliceKeys.x25519PrivateKey,
      },
      senderEd25519KeyPair: {
        publicKey: aliceKeys.ed25519PublicKey,
        privateKey: aliceKeys.ed25519PrivateKey,
      },
      conversationId: "room-1",
      senderUserId: "alice",
      senderDeviceId: aliceKeys.deviceId,
      keyEpoch: 2,
      messageId: "msg-current",
    });

    const plaintext = await service.open({
      envelope,
      recipientX25519PrivateKey: bobKeys.x25519PrivateKey,
      senderX25519PublicKey: aliceKeys.x25519PublicKey,
      senderEd25519PublicKey: aliceKeys.ed25519PublicKey,
      keyEpoch: 2,
    });

    expect(new TextDecoder().decode(plaintext)).toBe("current payload");
  });

  it("Hub rejects malformed envelopes regardless of key epoch (fail closed)", async () => {
    const hub = makeHub({ envelopeService: new EnvelopeService() });
    const transport = await connectClient(hub, "c-alice", "alice", "tenant-a", "cred-alice");

    const bad = {
      protocolVersion: 1,
      conversationId: "room-1",
      senderUserId: "alice",
      senderDeviceId: "dev-1",
      messageId: "msg-bad",
      keyEpoch: 1,
      nonce: new Uint8Array(16), // wrong length (should be 24)
      ciphertext: new Uint8Array([1, 2, 3]),
    } as never;

    await expect(hub.sendEnvelope("c-alice", bad)).rejects.toThrow(
      InvalidEnvelopeError,
    );
    hub.close();
  });
});

// ---------------------------------------------------------------------------
// Integration: Hub + room-namespace standalone router (separate systems)
// ---------------------------------------------------------------------------

describe("integration — Hub + room-namespace standalone router", () => {
  let hub: Hub;
  let aliceTransport: FakeTransport;
  let store: IntegrationStore;
  let router: RoomNamespaceRouter;
  let authorizeJoinCalls: Array<{ userId: string; roomKey: string }>;

  beforeEach(async () => {
    hub = makeHub();
    store = new IntegrationStore();
    await store.createNamespace({ tenantId: "tenant-1", namespaceId: "ns-1", policyId: "p" });
    await store.createRoom({
      tenantId: "tenant-1",
      namespaceId: "ns-1",
      roomId: "room-1",
      maxMembers: 10,
      encryptionPolicy: "disabled",
    });

    authorizeJoinCalls = [];
    const authorizeJoin = async (principal: { userId: string; tenantId: string }, roomKey: string) => {
      authorizeJoinCalls.push({ userId: principal.userId, roomKey });
      return principal.userId !== "banned-user";
    };

    router = new RoomNamespaceRouter({
      store,
      authorizeJoin,
      authorizePublish: async () => true,
    });

    aliceTransport = await connectClient(hub, "c-alice", "alice", "tenant-a", "cred-alice");

    await hub.joinRoom("c-alice", "room-1");
  });

  afterEach(() => {
    hub.close();
  });

  it("the standalone router enforces authorization independently", async () => {
    // The standalone router rejects banned users based on its own authorizeJoin.
    const result = await router.joinRoom(
      { userId: "banned-user", tenantId: "tenant-a" },
      { id: "c-banned" } as never,
      "tenant-1",
      "ns-1",
      "room-1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNAUTHORIZED_JOIN");
    }

    // Authorized users can join via the standalone router.
    const okResult = await router.joinRoom(
      { userId: "alice", tenantId: "tenant-a" },
      { id: "c-alice-standalone" } as never,
      "tenant-1",
      "ns-1",
      "room-1",
    );
    expect(okResult.ok).toBe(true);
  });

  it("the Hub and standalone router are separate membership systems", async () => {
    // Hub membership uses plain roomId keys ("room-1").
    const hubMembers = await hub["membership"].members("room-1");
    expect(hubMembers).toContain("c-alice");

    // Standalone router membership uses encoded room keys.
    const roomKey = encodeRoomKey("tenant-1", "ns-1", "room-1");
    const standaloneMembers = await store.getMembers(roomKey);
    expect(standaloneMembers.length).toBe(0); // standalone router wasn't used to join

    // After using the standalone router, its store reflects the membership.
    await router.joinRoom(
      { userId: "alice", tenantId: "tenant-a" },
      { id: "c-alice" } as never,
      "tenant-1",
      "ns-1",
      "room-1",
    );
    const afterMembers = await store.getMembers(roomKey);
    expect(afterMembers.map((m) => m.connectionId)).toContain("c-alice");
  });
});

// ---------------------------------------------------------------------------
// Integration: Collaboration document sync through Hub
// ---------------------------------------------------------------------------

describe("integration — Hub + Collaboration document sync", () => {
  let hub: Hub;
  let aliceTransport: FakeTransport;
  let bobTransport: FakeTransport;
  let aliceFrames: unknown[];
  let bobFrames: unknown[];

  beforeEach(async () => {
    hub = makeHub();
    aliceTransport = await connectClient(hub, "c-alice", "alice", "tenant-a", "cred-alice");
    bobTransport = await connectClient(hub, "c-bob", "bob", "tenant-a", "cred-bob");

    aliceFrames = collectFrames(aliceTransport);
    bobFrames = collectFrames(bobTransport);

    // Both subscribe to document "doc-1".
    await hub.subscribeDocument("c-alice", "doc-1", "write");
    await hub.subscribeDocument("c-bob", "doc-1", "read");
  });

  afterEach(() => {
    hub.close();
  });

  it("routes a collaboration insert op through Hub document publish to subscriber", async () => {
    const bobEngine = new ApplyEngine();

    // Alice creates a local insert op: insert "h" after ROOT.
    const op: TextInsertOperation = {
      kind: "text.insert",
      opId: { actorId: "alice", counter: 1 },
      deps: {},
      after: "ROOT",
      value: "h",
    };

    // Validate the op shape before sending.
    validateOperation(op);
    validateSchemaVersion(1);

    // Encode to canonical bytes.
    const encoded = encodeOperation(op);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.byteLength).toBeGreaterThan(0);

    // Alice publishes via Hub document routing (exclude sender).
    const result = await hub.publish("c-alice", {
      type: "collab:op",
      documentId: "doc-1",
      payload: { op: Array.from(encoded) },
      excludeSender: true,
    } as never);
    expect(result.status).toBe("delivered");
    if (result.status === "delivered") {
      expect(result.recipientCount).toBe(1); // bob only
    }

    // Allow async delivery to flush.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Bob receives the encoded op bytes.
    expect(bobFrames.length).toBe(1);
    const received = bobFrames[0] as { data: Uint8Array };
    const decoded = JSON.parse(new TextDecoder().decode(received.data));
    expect(decoded.type).toBe("collab:op");

    // Bob decodes the byte array back to a Uint8Array.
    const bobEncoded = new Uint8Array(decoded.payload.op as number[]);

    // Bob parses the canonical JSON to reconstruct the operation.
    const opJson = JSON.parse(new TextDecoder().decode(bobEncoded));
    const bobOp: CrdtOperation = {
      kind: opJson.kind as "text.insert",
      opId: decodeElementId(opJson.opId as string),
      deps: opJson.deps as VectorClock,
      after: opJson.after === "ROOT" ? "ROOT" : decodeElementId(opJson.after as string),
      value: opJson.value as string,
    } as CrdtOperation;

    // Bob validates and applies the op.
    validateOperation(bobOp);
    const applyResult = bobEngine.apply(bobOp);
    expect(applyResult.status).toBe("applied");

    // Bob's engine now has the text.
    expect(bobEngine.getState().text).toBe("h");
  });

  it("rejects publishing to a document without write subscription", async () => {
    // Charlie is not subscribed to doc-1.
    const charlieTransport = await connectClient(hub, "c-charlie", "charlie", "tenant-a", "cred-charlie");

    const result = await hub.publish("c-charlie", {
      type: "collab:op",
      documentId: "doc-1",
      payload: { op: {} },
    } as never);

    // Charlie has no write subscription, so the publish is rejected.
    expect(result.status).toBe("rejected");

    hub.disconnect("c-charlie", "test cleanup");
  });
});

