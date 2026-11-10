/**
 * Presence Adapter.
 *
 * Bridges the Core Hub's synchronous presence interface to the consolidated
 * Presence subsystem (`src/presence/`). The Core Hub expects simple
 * connection-scoped presence (set/addRoom/removeRoom/addDocument/removeDocument/remove),
 * while the consolidated service is device-lease based with async storage.
 *
 * Local Maps track per-connection room/document membership for fast sync
 * access by the Hub; the consolidated service owns the durable lease store
 * and expiry.
 */
import { PresenceService } from "../../presence/service.js";
import { InMemoryPresenceStore } from "../../presence/storage.js";
import { AuthorizationManager } from "../../presence/authorization-manager.js";
import { PresenceEventPublisher } from "../../presence/event-publisher.js";
import { AwarenessManager } from "../../presence/awareness-manager.js";
import type { Principal } from "../connection/connection.types.js";
import { DEFAULT_PRESENCE_CONFIG } from "../../presence/types.js";

export interface PresenceLease {
  userId: string;
  tenantId: string;
  lastSeenAt: number;
  rooms: Set<string>;
  documents: Set<string>;
}

interface ConnectionPresenceState {
  deviceId: string;
  principal: Principal;
  rooms: Set<string>;
  documents: Set<string>;
  lastSeenAt: number;
}

export class PresenceAdapter {
  private readonly store: InMemoryPresenceStore;
  private readonly service: PresenceService;
  private readonly connections = new Map<string, ConnectionPresenceState>();

  constructor() {
    this.store = new InMemoryPresenceStore();
    this.service = new PresenceService({
      store: this.store,
      authorization: new AuthorizationManager(),
      publisher: new PresenceEventPublisher(() => {}),
      awareness: new AwarenessManager(
        { ...DEFAULT_PRESENCE_CONFIG },
        () => {},
      ),
    });
  }

  /** Called on connection authentication. */
  async set(
    connectionId: string,
    principal: Principal,
    lastSeenAt: number,
  ): Promise<void> {
    await this.service.connect(principal as never, {
      connectionId,
      deviceId: connectionId,
    });
    this.connections.set(connectionId, {
      deviceId: connectionId,
      principal,
      rooms: new Set(),
      documents: new Set(),
      lastSeenAt,
    });
  }

  /** Refresh last-seen (heartbeat). */
  touch(connectionId: string, lastSeenAt: number): boolean {
    const state = this.connections.get(connectionId);
    if (!state) {
      return false;
    }
    state.lastSeenAt = lastSeenAt;
    void this.service.heartbeat(connectionId);
    return true;
  }

  addRoom(connectionId: string, roomId: string): void {
    const state = this.connections.get(connectionId);
    if (state) {
      state.rooms.add(roomId);
    }
  }

  removeRoom(connectionId: string, roomId: string): void {
    const state = this.connections.get(connectionId);
    if (state) {
      state.rooms.delete(roomId);
    }
  }

  addDocument(connectionId: string, documentId: string): void {
    const state = this.connections.get(connectionId);
    if (state) {
      state.documents.add(documentId);
    }
  }

  removeDocument(connectionId: string, documentId: string): void {
    const state = this.connections.get(connectionId);
    if (state) {
      state.documents.delete(documentId);
    }
  }

  /** Remove a connection entirely. Returns adapted lease info or undefined. */
  remove(connectionId: string): PresenceLease | undefined {
    const state = this.connections.get(connectionId);
    if (!state) {
      return undefined;
    }
    this.connections.delete(connectionId);
    void this.service.disconnect(connectionId);
    return {
      userId: state.principal.userId,
      tenantId: state.principal.tenantId,
      lastSeenAt: state.lastSeenAt,
      rooms: state.rooms,
      documents: state.documents,
    };
  }

  isOnline(connectionId: string): boolean {
    return this.connections.has(connectionId);
  }

  userConnectionIds(userId: string): string[] {
    const ids: string[] = [];
    for (const [cid, state] of this.connections) {
      if (state.principal.userId === userId) {
        ids.push(cid);
      }
    }
    return ids;
  }

  tenantConnectionCount(tenantId: string): number {
    let count = 0;
    for (const state of this.connections.values()) {
      if (state.principal.tenantId === tenantId) {
        count += 1;
      }
    }
    return count;
  }
}
