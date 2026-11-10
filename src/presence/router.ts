/**
 * Presence Router — REST + WebSocket routing for the Presence API.
 *
 * Public API endpoints:
 *   GET    /v1/presence/users/{userId}     — Retrieve user presence
 *   GET    /v1/presence/devices/{deviceId} — Retrieve device presence
 *   GET    /v1/presence/rooms/{roomId}     — Retrieve room presence
 *   PATCH  /v1/presence/me/status          — Change own status
 *   PATCH  /v1/presence/me/custom-status   — Change custom status
 *   WS     /v1/presence/connect            — WebSocket presence connection
 *
 * All requests are authenticated via Bearer token.
 */

import type {
  AuthenticatedPrincipal,
  DevicePresence,
  DeviceStatus,
  UserPresence,
} from "./types.js";
import type {
  TransportConnection,
  TransportMessage,
  TransportCloseEvent,
} from "../core/connection/connection.types.js";
import { PresenceService } from "./service.js";
import { AuthorizationManager } from "./authorization-manager.js";

// ---------------------------------------------------------------------------
// REST API handler types
// ---------------------------------------------------------------------------

/**
 * REST request context with authenticated principal.
 */
export interface PresenceRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  body?: unknown;
  principal: AuthenticatedPrincipal;
}

/**
 * REST response.
 */
export interface PresenceResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Presence Router
// ---------------------------------------------------------------------------

export class PresenceRouter {
  private readonly service: PresenceService;
  private readonly authorization: AuthorizationManager;

  constructor(service: PresenceService, authorization?: AuthorizationManager) {
    this.service = service;
    this.authorization = authorization ?? new AuthorizationManager();
  }

  /**
   * Route an HTTP request to the appropriate handler.
   */
  async route(request: PresenceRequest): Promise<PresenceResponse> {
    const { method, path, params, body, principal } = request;

    // Normalize path: remove leading/trailing slashes
    const normalizedPath = path.replace(/^\/+|\/+$/g, "");

    // Match routes
    if (method === "GET" && normalizedPath.startsWith("v1/presence/users/")) {
      return this.handleGetUser(params, principal);
    }

    if (method === "GET" && normalizedPath.startsWith("v1/presence/devices/")) {
      return this.handleGetDevice(params, principal);
    }

    if (method === "GET" && normalizedPath.startsWith("v1/presence/rooms/")) {
      return this.handleGetRoom(params, principal);
    }

    if (method === "PATCH" && normalizedPath === "v1/presence/me/status") {
      return this.handlePatchStatus(body, principal);
    }

    if (method === "PATCH" && normalizedPath === "v1/presence/me/custom-status") {
      return this.handlePatchCustomStatus(body, principal);
    }

    return { status: 404, body: { error: { code: "PRESENCE_NOT_FOUND", message: "Endpoint not found" } } };
  }

  // ------------------------------------------------------------------
  // Route handlers
  // ------------------------------------------------------------------

  private async handleGetUser(
    params: Record<string, string>,
    principal: AuthenticatedPrincipal,
  ): Promise<PresenceResponse> {
    const userId = params["userId"];
    if (!userId) {
      return { status: 400, body: { error: { code: "PRESENCE_INVALID_PAYLOAD", message: "Missing userId" } } };
    }

    const presence = await this.service.getUser(principal, userId);
    if (!presence) {
      return { status: 404, body: { error: { code: "PRESENCE_NOT_FOUND", message: "User presence not found or not authorized" } } };
    }

    return { status: 200, body: presence };
  }

  private async handleGetDevice(
    params: Record<string, string>,
    principal: AuthenticatedPrincipal,
  ): Promise<PresenceResponse> {
    const deviceId = params["deviceId"];
    if (!deviceId) {
      return { status: 400, body: { error: { code: "PRESENCE_INVALID_PAYLOAD", message: "Missing deviceId" } } };
    }

    const presence = await this.service.getDevice(principal, deviceId);
    if (!presence) {
      return { status: 404, body: { error: { code: "PRESENCE_NOT_FOUND", message: "Device presence not found or not authorized" } } };
    }

    return { status: 200, body: presence };
  }

  private async handleGetRoom(
    params: Record<string, string>,
    principal: AuthenticatedPrincipal,
  ): Promise<PresenceResponse> {
    const roomId = params["roomId"];
    if (!roomId) {
      return { status: 400, body: { error: { code: "PRESENCE_INVALID_PAYLOAD", message: "Missing roomId" } } };
    }

    const members = await this.service.getRoom(principal, roomId);
    return { status: 200, body: { roomId, members } };
  }

  private async handlePatchStatus(
    body: unknown,
    principal: AuthenticatedPrincipal,
  ): Promise<PresenceResponse> {
    const status = (body as { status?: unknown })?.status;
    const deviceId = principal.userId; // Default device ID

    if (!AuthorizationManager.isValidStatus(status)) {
      return { status: 400, body: { error: { code: "PRESENCE_INVALID_STATUS", message: "Invalid status value" } } };
    }

    try {
      const presence = await this.service.setStatus(principal, deviceId, status);
      return { status: 200, body: {
        success: true,
        deviceStatus: status,
        userStatus: presence.status,
        updatedAt: presence.updatedAt,
      } };
    } catch (error) {
      return { status: 403, body: { error: { code: "PRESENCE_FORBIDDEN", message: (error as Error).message } } };
    }
  }

  private async handlePatchCustomStatus(
    body: unknown,
    principal: AuthenticatedPrincipal,
  ): Promise<PresenceResponse> {
    const customStatus = (body as { customStatus?: unknown })?.customStatus;

    if (typeof customStatus !== "string" || customStatus.length > 256) {
      return { status: 400, body: { error: { code: "PRESENCE_INVALID_PAYLOAD", message: "Invalid customStatus" } } };
    }

    // Custom status update — sets device status to "away" with custom text
    try {
      const presence = await this.service.setStatus(principal, principal.userId, "away");
      return { status: 200, body: {
        success: true,
        customStatus,
        updatedAt: presence.updatedAt,
      } };
    } catch (error) {
      return { status: 403, body: { error: { code: "PRESENCE_FORBIDDEN", message: (error as Error).message } } };
    }
  }

  // ------------------------------------------------------------------
  // WebSocket connection handler
  // ------------------------------------------------------------------

  /**
   * Handle a WebSocket presence connection.
   * Called by the transport adapter when a client connects to /v1/presence/connect.
   */
  async handleWebSocketConnect(
    socket: TransportConnection,
    principal: AuthenticatedPrincipal,
    deviceId?: string,
  ): Promise<void> {
    // Register the connection with the presence service
    await this.service.connect(principal, {
      connectionId: socket.id,
      deviceId,
    });

    // Set up message handlers for awareness events
    socket.onMessage((message: TransportMessage) => {
      try {
        const data = typeof message.data === "string"
          ? message.data
          : new TextDecoder().decode(message.data);
        const parsed = JSON.parse(data);
        this.handleWebSocketMessage(socket, principal, parsed);
      } catch {
        // Invalid JSON — ignore
      }
    });

    socket.onClose(() => {
      void this.service.disconnect(socket.id);
    });
  }

  private async handleWebSocketMessage(
    socket: TransportConnection,
    principal: AuthenticatedPrincipal,
    message: unknown,
  ): Promise<void> {
    const msg = message as { type?: string; [key: string]: unknown };

    switch (msg.type) {
      case "awareness.typing.start": {
        const roomId = String(msg.roomId ?? "");
        this.service.typingStart(principal.userId, roomId);
        break;
      }
      case "awareness.typing.stop": {
        const roomId = String(msg.roomId ?? "");
        this.service.typingStop(principal.userId, roomId);
        break;
      }
      case "awareness.cursor.update": {
        const roomId = String(msg.roomId ?? "");
        const documentId = String(msg.documentId ?? "");
        this.service.cursorUpdate(principal.userId, roomId, documentId, msg.cursor);
        break;
      }
      default:
        // Unknown message type — ignore
        break;
    }
  }
}
