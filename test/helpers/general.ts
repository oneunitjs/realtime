/**
 * Shared fixtures for general package integration tests.
 *
 * Drives the real `Hub` through test transport connections. No external
 * infrastructure (Redis/Postgres/uWS) is required; these tests exercise the
 * Hub's auth, routing, fan-out, presence, and frame handling directly.
 */

import { Hub, type HubOptions } from "../../src/core/core-hub.js";
import type { AuthProvider } from "../../src/core/auth/auth-provider.js";
import type {
  Principal,
  SendResult,
  TransportConnection,
  TransportMessage,
} from "../../src/core/connection/connection.types.js";
import { DEFAULT_HUB_CONFIG } from "../../src/core/connection/connection.types.js";
import { jsonCodec, PROTOCOL_VERSION } from "../../src/protocol/json.js";

export function makePrincipalOverrides(userId: string): Principal {
  return { userId, tenantId: "tenant-a", roles: ["user"], sessionId: "s1" };
}

export function makeAuthProvider(principalByCredential?: Record<string, Principal>): AuthProvider {
  return {
    authenticate: async (credential) => {
      if (principalByCredential && credential) {
        const p = principalByCredential[credential];
        if (p) return p;
        throw new Error("unknown credential");
      }
      return { userId: String(credential), tenantId: "tenant-a", roles: ["user"], sessionId: "s1" };
    },
  };
}

export function makeHub(options: {
  authProvider?: AuthProvider;
  authorize?: (action: string, principal: Principal, resourceId?: string) => boolean;
  config?: Partial<import("../../../src/core/connection/connection.types.js").HubConfig>;
}): Hub {
  return new Hub({
    authProvider: options.authProvider ?? makeAuthProvider(),
    authorize: options.authorize ?? (() => true),
    config: { ...DEFAULT_HUB_CONFIG, ...options.config },
  } as HubOptions);
}

/** Encode a client→server frame the Hub will decode (JSON codec). */
export function encodeFrameMsg(envelope: { type: string; [key: string]: unknown }): Uint8Array {
  return jsonCodec.encode({ protocolVersion: PROTOCOL_VERSION, ...envelope });
}

/**
 * Simple test transport that satisfies TransportConnection. Records all
 * outbound frames and exposes them via `sent`. Works reliably under vitest
 * (unlike FakeTransport, whose class fields are broken by esbuild class-field
 * transpilation).
 */
export class TestTransport implements TransportConnection {
  readonly id: string;
  readonly remoteAddress?: string;
  state: "open" | "closing" | "closed" = "open";
  closed = false;
  sent: TransportMessage[] = [];

  private onMessageHandlers = new Array<(message: TransportMessage) => void>();
  private onSendHandlers = new Array<(message: TransportMessage) => void>();
  private onCloseHandlers = new Array<(event: { code: number; reason: string; wasClean: boolean }) => void>();
  private onDrainHandlers = new Array<() => void>();

  constructor(id: string) {
    this.id = id;
  }

  send(data: Uint8Array, _options?: { compress?: boolean }): Promise<SendResult> {
    if (this.closed || this.state === "closed") {
      return Promise.reject(new Error("transport is closed"));
    }
    const message: TransportMessage = { data: new Uint8Array(data), isBinary: true };
    this.sent.push(message);
    for (const handler of this.onSendHandlers) {
      try { handler(message); } catch { /* isolated */ }
    }
    return Promise.resolve({ status: "accepted", bufferedBytes: 0 });
  }

  async close(code = 1000, reason = ""): Promise<void> {
    if (this.closed) return;
    this.state = "closed";
    this.closed = true;
    const handlers = [...this.onCloseHandlers];
    for (const handler of handlers) {
      try { handler({ code, reason, wasClean: true }); } catch { /* isolated */ }
    }
  }

  onMessage(handler: (message: TransportMessage) => void): () => void {
    this.onMessageHandlers.push(handler);
    return () => {
      this.onMessageHandlers = this.onMessageHandlers.filter((h) => h !== handler);
    };
  }

  onSend(handler: (message: TransportMessage) => void): () => void {
    this.onSendHandlers.push(handler);
    return () => {
      this.onSendHandlers = this.onSendHandlers.filter((h) => h !== handler);
    };
  }

  onClose(handler: (event: { code: number; reason: string; wasClean: boolean }) => void): () => void {
    this.onCloseHandlers.push(handler);
    return () => {
      this.onCloseHandlers = this.onCloseHandlers.filter((h) => h !== handler);
    };
  }

  onDrain(handler: () => void): () => void {
    this.onDrainHandlers.push(handler);
    return () => {
      this.onDrainHandlers = this.onDrainHandlers.filter((h) => h !== handler);
    };
  }

  bufferedBytes(): number { return 0; }

  receive(data: Uint8Array, isBinary = true): void {
    if (this.closed) return;
    const message: TransportMessage = { data: new Uint8Array(data), isBinary };
    for (const handler of this.onMessageHandlers) {
      try { handler(message); } catch { /* isolated */ }
    }
  }

  closeRemote(code = 1000, reason = ""): void {
    this.closed = true;
    this.state = "closed";
    const handlers = [...this.onCloseHandlers];
    for (const handler of handlers) {
      try { handler({ code, reason, wasClean: true }); } catch { /* isolated */ }
    }
  }
}

/** Connect a TestTransport to the hub and return it. */
export async function connectClient(hub: Hub, id: string, credential = "cred"): Promise<TestTransport> {
  const transport = new TestTransport(id);
  await hub.connect(transport, credential);
  return transport;
}

/** A transport whose `send` always reports `dropped` (backpressure limit). */
export class DroppingTransport extends TestTransport {
  override send(): Promise<{ status: "dropped"; bufferedBytes: number }> {
    return Promise.resolve({ status: "dropped", bufferedBytes: 0 });
  }
}

/** Collect frames sent by the hub to a transport via its onSend hook. */
export function collectSent(transport: TestTransport): Array<{ type: string }> {
  const frames: Array<{ type: string }> = [];
  transport.onSend((message) => {
    try {
      frames.push(message as { type: string });
    } catch {
      // ignore
    }
  });
  return frames;
}
