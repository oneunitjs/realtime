/**
 * Shared fixtures for collab integration tests.
 *
 * Drives the real `collaboration()` middleware through mock socket objects
 * that implement the subset of the Socket.IO / transport socket surface the
 * middleware consumes (`id`, `data`, `emit`, `on`, `once`, `join`, `leave`,
 * `handshake`/`request`). Storage is `MemoryStorage` (the Postgres-backed
 * `CollaborationStorage` is a separate deliverable per the production test
 * plan).
 */

import { collaboration, type CollaborationOptions } from "../../src/collab/index.js";
import { MemoryStorage, type CollaborationStorage } from "../../src/collab/server/storage.js";
import type { AuthenticatedPrincipal } from "../../src/collab/server/principal.js";
import type { DocumentScope } from "../../src/collab/server/document-key.js";
import type { CrdtOperation, ElementId, VectorClock } from "../../src/collab/core/types.js";

/** Emitted server->client event captured by the mock socket. */
export interface EmittedEvent {
  event: string;
  payload: unknown;
}

/** Mock socket implementing the surface used by the collaboration middleware. */
export class MockSocket {
  public id: string;
  public data: Record<string, unknown> = {};
  public readonly emitted: EmittedEvent[] = [];
  public readonly received: Array<{ event: string; payload: unknown }> = [];
  public handshake: { url?: string; headers: Record<string, string> } = {
    url: "",
    headers: {},
  };
  public request = { url: "", headers: {} };

  private readonly handlers = new Map<string, Array<(payload: unknown) => void>>();
  private readonly onceHandlers = new Map<string, Array<(payload: unknown) => void>>();

  constructor(id: string) {
    this.id = id;
  }

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
  }

  on(event: string, handler: (payload: unknown) => void): void {
    let arr = this.handlers.get(event);
    if (!arr) {
      arr = [];
      this.handlers.set(event, arr);
    }
    arr.push(handler);
  }

  once(event: string, handler: (payload: unknown) => void): void {
    let arr = this.onceHandlers.get(event);
    if (!arr) {
      arr = [];
      this.onceHandlers.set(event, arr);
    }
    arr.push(handler);
  }

  join(_room: string): void {}
  leave(_room: string): void {}

  /** Deliver a client->server message to the registered handler(s). */
  receive(event: string, payload: unknown): void {
    this.received.push({ event, payload });
    const handlers = [...(this.handlers.get(event) ?? [])];
    for (const handler of handlers) {
      handler(payload);
    }
  }

  /** Deliver a client->server message to a one-time handler, consuming it. */
  receiveOnce(event: string, payload: unknown): void {
    this.received.push({ event, payload });
    const handlers = [...(this.onceHandlers.get(event) ?? [])];
    this.onceHandlers.delete(event);
    for (const handler of handlers) {
      handler(payload);
    }
  }

  lastEmitted(event: string): unknown | undefined {
    for (let i = this.emitted.length - 1; i >= 0; i--) {
      if (this.emitted[i].event === event) {
        return this.emitted[i].payload;
      }
    }
    return undefined;
  }

  emittedOf(event: string): unknown[] {
    return this.emitted.filter((e) => e.event === event).map((e) => e.payload);
  }

  clearEmitted(): void {
    this.emitted.length = 0;
  }
}

/** Authenticated principal fixture. */
export function makePrincipal(params: {
  userId?: string;
  tenantId?: string;
  actorId?: string;
  roles?: readonly string[];
}): AuthenticatedPrincipal {
  return {
    userId: params.userId ?? "alice",
    tenantId: params.tenantId ?? "tenant-a",
    actorId: params.actorId ?? "alice-device-1",
    roles: params.roles ?? ["user"],
    sessionId: "s1",
  };
}

/** Composite document scope fixture. */
export function makeScope(params: {
  tenantId?: string;
  documentId?: string;
}): DocumentScope {
  return {
    tenantId: params.tenantId ?? "tenant-a",
    documentId: params.documentId ?? "doc-1",
  };
}

/** Text insert operation fixture. */
export function makeInsertOp(params: {
  actorId: string;
  counter: number;
  value: string;
  after?: ElementId | "ROOT";
  deps?: VectorClock;
}): CrdtOperation {
  return {
    kind: "text.insert",
    opId: { actorId: params.actorId, counter: params.counter },
    deps: params.deps ?? {},
    after: params.after ?? "ROOT",
    value: params.value,
  } as CrdtOperation;
}

/** Map set operation fixture. */
export function makeMapSetOp(params: {
  actorId: string;
  counter: number;
  key: string;
  value: unknown;
  logicalTime?: number;
}): CrdtOperation {
  return {
    kind: "map.set",
    opId: { actorId: params.actorId, counter: params.counter },
    deps: {},
    key: params.key,
    value: params.value,
    logicalTime: params.logicalTime ?? 1,
  } as CrdtOperation;
}

/** Map delete operation fixture. */
export function makeMapDeleteOp(params: {
  actorId: string;
  counter: number;
  key: string;
  logicalTime?: number;
}): CrdtOperation {
  return {
    kind: "map.delete",
    opId: { actorId: params.actorId, counter: params.counter },
    deps: {},
    key: params.key,
    logicalTime: params.logicalTime ?? 1,
  } as CrdtOperation;
}

/** Always-success authentication provider. */
export function makeAuthenticate(principal: AuthenticatedPrincipal | null) {
  return async (_context: { url?: string; headers?: Record<string, string> }) => principal;
}

/** Always-success authorization provider. */
export function makeAuthorize(result = true) {
  return async () => result;
}

/**
 * Create a `collaboration()` module backed by MemoryStorage, wired with the
 * given authenticate/authorize hooks and an optional `send` override for the
 * broadcaster. Returns the module plus the storage instance (useful for
 * restart / persistence tests that share one storage across module instances).
 *
 * When a `principal` is supplied, `authenticate` defaults to returning it, so
 * the async handshake callback does not emit spurious `UNAUTHORIZED` errors;
 * `setupClient` still binds the principal on the socket synchronously.
 */
export function createCollabModule(options: Partial<CollaborationOptions> & { principal?: AuthenticatedPrincipal } = {}) {
  const storage = (options.storage as CollaborationStorage | undefined) ?? new MemoryStorage();
  const principal = options.principal;
  const authenticate = options.authenticate ?? makeAuthenticate(principal ?? null);
  const authorize = options.authorize ?? makeAuthorize(true);
  const module = collaboration({
    storage,
    authenticate,
    authorize,
    ...options,
  });
  return { module, storage };
}

/**
 * Create a mock socket, run the collaboration middleware on it, and (when a
 * principal is supplied) mark it authenticated so document.open / operation
 * submission paths can be exercised without waiting on the async handshake.
 */
export function setupClient(
  module: ReturnType<typeof createCollabModule>,
  principal: AuthenticatedPrincipal | null = null,
): MockSocket {
  const socket = new MockSocket(`conn-${crypto.randomUUID().slice(0, 6)}`);
  const next = () => undefined;
  module.middleware()(socket, next);
  if (principal) {
    socket.data.authenticated = true;
    socket.data.principal = principal;
  }
  return socket;
}

/** Wait for the microtask queue to drain (lets async auth settle). */
export async function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Deliver a client->server message to the registered handler and let any
 *  async work inside the handler complete before returning. */
export async function deliver(
  socket: MockSocket,
  event: string,
  payload: unknown,
): Promise<void> {
  socket.receive(event, payload);
  await nextTick();
}
