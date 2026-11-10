/**
 * Connection registry and lifecycle.
 *
 * Stores connections by connectionId. State transitions happen only through
 * the lifecycle service. Each connection carries an AbortController created
 * at registration, used to cancel in-flight work on disconnect.
 */
import type {
  ClientConnection,
  ConnectionState,
  Principal,
  TransportConnection,
} from "../connection/connection.types.js";
import type { Clock } from "../infrastructure/clock.js";
import type { IdGenerator } from "../infrastructure/id-generator.js";

interface ConnectionEntry extends ClientConnection {}

export class ConnectionRegistry {
  private readonly connections = new Map<string, ConnectionEntry>();

  constructor(
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator
  ) {}

  register(
    transport: TransportConnection,
    idGeneratorOverride?: () => string
  ): ClientConnection {
    const id = idGeneratorOverride ? idGeneratorOverride() : transport.id;
    const now = this.clock.now();
    const abort = new AbortController();

    const entry: ClientConnection = {
      id,
      state: "connecting",
      transport,
      connectedAt: now,
      lastSeenAt: now,
      abort,
    };

    this.connections.set(id, entry);
    return entry;
  }

  get(connectionId: string): ClientConnection | undefined {
    return this.connections.get(connectionId);
  }

  has(connectionId: string): boolean {
    return this.connections.has(connectionId);
  }

  setState(connectionId: string, state: ConnectionState): boolean {
    const entry = this.connections.get(connectionId);
    if (!entry) {
      return false;
    }
    entry.state = state;
    return true;
  }

  setPrincipal(connectionId: string, principal: Principal): boolean {
    const entry = this.connections.get(connectionId);
    if (!entry) {
      return false;
    }
    entry.principal = principal;
    return true;
  }

  touch(connectionId: string): boolean {
    const entry = this.connections.get(connectionId);
    if (!entry) {
      return false;
    }
    entry.lastSeenAt = this.clock.now();
    return true;
  }

  remove(connectionId: string): ClientConnection | undefined {
    const entry = this.connections.get(connectionId);
    if (!entry) {
      return undefined;
    }
    this.connections.delete(connectionId);
    return entry;
  }

  /** Abort all in-flight work for a connection and mark it closing. */
  beginClose(connectionId: string): ClientConnection | undefined {
    const entry = this.connections.get(connectionId);
    if (!entry) {
      return undefined;
    }
    if (entry.state === "closing" || entry.state === "closed") {
      return entry;
    }
    entry.state = "closing";
    entry.abort.abort();
    return entry;
  }

  markClosed(connectionId: string): boolean {
    const entry = this.connections.get(connectionId);
    if (!entry) {
      return false;
    }
    entry.state = "closed";
    return true;
  }

  all(): ClientConnection[] {
    return [...this.connections.values()];
  }

  size(): number {
    return this.connections.size;
  }
}
