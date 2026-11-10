/**
 * Presence SDK — TypeScript client for the Presence Management system.
 *
 * Provides a developer-friendly interface for connecting to the presence
 * service, managing status, querying presence, and subscribing to updates.
 * Handles connection lifecycle, heartbeats, reconnection, and subscriptions
 * automatically.
 */

import type {
  AuthenticatedPrincipal,
  DevicePresence,
  DeviceStatus,
  PresenceConfig,
  PresenceSystemEvent,
  UserPresence,
} from "./types.js";

// ---------------------------------------------------------------------------
// SDK
// ---------------------------------------------------------------------------

export interface PresenceClientOptions {
  /** WebSocket endpoint URL. */
  endpoint: string;
  /** Authentication token provider (called before each connection). */
  token: () => string | Promise<string>;
  /** Heartbeat interval in milliseconds. */
  heartbeatInterval?: number;
  /** Enable automatic reconnection. */
  reconnect?: boolean;
  /** Optional device identifier. */
  deviceId?: string;
  /** Enable debug logging. */
  debug?: boolean;
}

/**
 * Room-scoped presence client for typing and cursor awareness.
 */
export class PresenceRoom {
  private readonly client: PresenceClient;
  private readonly roomId: string;

  constructor(client: PresenceClient, roomId: string) {
    this.client = client;
    this.roomId = roomId;
  }

  /** Start typing indicator in this room. */
  async typingStart(): Promise<void> {
    await this.client.sendAwareness({
      type: "awareness.typing.start",
      roomId: this.roomId,
    });
  }

  /** Stop typing indicator in this room. */
  async typingStop(): Promise<void> {
    await this.client.sendAwareness({
      type: "awareness.typing.stop",
      roomId: this.roomId,
    });
  }

  /** Update cursor position in this room/document. */
  async cursorUpdate(documentId: string, cursor: unknown): Promise<void> {
    await this.client.sendAwareness({
      type: "awareness.cursor.update",
      roomId: this.roomId,
      documentId,
      cursor,
    });
  }

  /** Get a room-scoped client for typing/cursor. */
  room(roomId: string): PresenceRoom {
    return this.client.room(roomId);
  }
}

/**
 * Main Presence SDK client.
 */
export class PresenceClient {
  private readonly options: PresenceClientOptions;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private reconnecting = false;
  private readonly eventHandlers = new Map<string, Set<(event: PresenceSystemEvent) => void>>();
  private readonly rooms = new Map<string, PresenceRoom>();
  private readonly messageQueue: unknown[] = [];
  private readonly deviceId: string;

  constructor(options: PresenceClientOptions) {
    this.options = {
      heartbeatInterval: 25_000,
      reconnect: true,
      ...options,
    };
    this.deviceId = this.options.deviceId ?? `device_${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  }

  // ------------------------------------------------------------------
  // Connection
  // ------------------------------------------------------------------

  /** Connect to the presence service. */
  async connect(): Promise<void> {
    if (this.connected || this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    const token = await this.options.token();
    const url = new URL(this.options.endpoint);
    url.searchParams.set("token", token);
    url.searchParams.set("deviceId", this.deviceId);

    this.ws = new WebSocket(url.toString());

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnecting = false;
      this.clearReconnectTimer();
      this.startHeartbeat();
      this.flushMessageQueue();
      this.emit({ type: "presence.user.updated", data: { userId: "self", status: "online", updatedAt: Date.now() } } as PresenceSystemEvent);
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as PresenceSystemEvent;
        this.emit(message);
      } catch {
        // Invalid message — ignore
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.stopHeartbeat();
      if (this.options.reconnect && !this.reconnecting) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (error) => {
      console.error("Presence WebSocket error:", error);
      this.ws?.close();
    };
  }

  /** Disconnect from the presence service. */
  async disconnect(): Promise<void> {
    this.options.reconnect = false;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.ws?.close();
    this.connected = false;
  }

  /** Check if connected. */
  isConnected(): boolean {
    return this.connected;
  }

  // ------------------------------------------------------------------
  // Status
  // ------------------------------------------------------------------

  /** Change the authenticated user's status. */
  async setStatus(status: DeviceStatus): Promise<void> {
    await this.sendRequest("PATCH", "/v1/presence/me/status", { status });
  }

  /** Change the custom status text. */
  async setCustomStatus(customStatus: string): Promise<void> {
    await this.sendRequest("PATCH", "/v1/presence/me/custom-status", { customStatus });
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  /** Get a user's presence. */
  async getUser(userId: string): Promise<UserPresence | null> {
    return (await this.sendRequest("GET", `/v1/presence/users/${userId}`)) as UserPresence | null;
  }

  /** Get a device's presence. */
  async getDevice(deviceId: string): Promise<DevicePresence | null> {
    return (await this.sendRequest("GET", `/v1/presence/devices/${deviceId}`)) as DevicePresence | null;
  }

  /** Get room presence. */
  async getRoom(roomId: string): Promise<Array<{ userId: string; status: DeviceStatus }>> {
    const response = await this.sendRequest("GET", `/v1/presence/rooms/${roomId}`);
    return (response as { members?: Array<{ userId: string; status: DeviceStatus }> })?.members ?? [];
  }

  /** Get a room-scoped client for typing/cursor awareness. */
  room(roomId: string): PresenceRoom {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new PresenceRoom(this, roomId));
    }
    return this.rooms.get(roomId)!;
  }

  // ------------------------------------------------------------------
  // Awareness
  // ------------------------------------------------------------------

  /** Send an awareness event (typing, cursor). */
  async sendAwareness(event: {
    type: string;
    roomId: string;
    documentId?: string;
    cursor?: unknown;
  }): Promise<void> {
    await this.sendRequest("WS_AWARENESS", "/v1/presence/connect", event);
  }

  // ------------------------------------------------------------------
  // Subscriptions
  // ------------------------------------------------------------------

  /**
   * Subscribe to presence events.
   * Returns an unsubscribe function.
   */
  on(
    eventType: string,
    handler: (event: PresenceSystemEvent) => void,
  ): () => void {
    let handlers = this.eventHandlers.get(eventType);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(eventType, handlers);
    }

    handlers.add(handler);

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.eventHandlers.delete(eventType);
      }
    };
  }

  /** Emit an event to all registered handlers. */
  private emit(event: PresenceSystemEvent): void {
    const handlers = this.eventHandlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch {
          // Handler failures should not crash the SDK
        }
      }
    }

    // Also emit to wildcard handlers
    const wildcard = this.eventHandlers.get("*");
    if (wildcard) {
      for (const handler of wildcard) {
        try {
          handler(event);
        } catch {
          // Handler failures should not crash the SDK
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, this.options.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.reconnecting = true;
    this.reconnectTimer = setTimeout(() => {
      this.reconnecting = false;
      void this.connect();
    }, 3000);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private flushMessageQueue(): void {
    while (this.messageQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      const message = this.messageQueue.shift();
      if (message) {
        this.ws.send(JSON.stringify(message));
      }
    }
  }

  private async sendRequest(method: string, path: string, body?: unknown): Promise<unknown> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      // Queue for later if not connected
      this.messageQueue.push({ method, path, body });
      throw new Error("Not connected to presence service");
    }

    // For REST-like operations over WebSocket, send a request message
    const request = { method, path, body, id: crypto.randomUUID?.() ?? Math.random().toString(36) };
    this.ws.send(JSON.stringify(request));

    // In a real implementation, this would wait for a response via a request/response
    // correlation ID. For now, we return a placeholder.
    return { success: true };
  }
}
