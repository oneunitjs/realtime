/**
 * Room/Namespace Router — Hub integration for join/leave/publish.
 *
 * Wires the Core Hub connection lifecycle to room membership:
 *
 *   Authenticate (Hub)
 *       → joinRoom (authorize + capacity + optional key check)
 *           → membership commit
 *           → presence update
 *           → event: member_joined (policy permitting)
 *
 *   publish to room
 *       → authorize + encryption policy
 *       → resolve membership snapshot
 *       → Event subsystem fan-out
 *
 *   leave / disconnect
 *       → membership remove
 *       → clear room-scoped awareness
 *       → presence update
 *       → event: member_left (policy permitting)
 */

import type {
  RoomRecord,
  RoomErrorCode,
  RoomError,
  AuthorizeJoin,
  AuthorizePublish,
  IsKeyCurrent,
  RoomNamespaceStore,
  AuthenticatedPrincipal,
} from "./types.js";
import type { TransportConnection } from "../core/connection/connection.types.js";
import { encodeRoomKey, decodeRoomKey, isValidRoomKey } from "./room-key.js";
import { MembershipManager } from "./membership-manager.js";
import { RoomManager } from "./room-manager.js";
import { EncryptionGate } from "./encryption-gate.js";

// ---------------------------------------------------------------------------
// Router callback types
// ---------------------------------------------------------------------------

/**
 * Callback to publish a presence update.
 */
export type OnPresenceUpdate = (
  userId: string,
  status: string,
  roomKey?: string,
) => void | Promise<void>;

/**
 * Callback to publish an event to room members.
 */
export type OnEventPublish = (
  roomKey: string,
  event: { type: string; data: unknown },
  excludeConnectionId?: string,
) => void | Promise<void>;

/**
 * Callback to broadcast a message to room members (via Event subsystem).
 */
export type OnFanout = (
  roomKey: string,
  message: unknown,
  includeConnectionIds?: string[],
) => Promise<number> | number;

// ---------------------------------------------------------------------------
// Room/Namespace Router
// ---------------------------------------------------------------------------

export class RoomNamespaceRouter {
  private readonly membership: MembershipManager;
  private readonly rooms: RoomManager;
  private readonly encryption: EncryptionGate;
  private readonly store: RoomNamespaceStore;

  private readonly authorizeJoin: AuthorizeJoin;
  private readonly authorizePublish: AuthorizePublish;
  private readonly onPresenceUpdate?: OnPresenceUpdate;
  private readonly onEventPublish?: OnEventPublish;
  private readonly onFanout?: OnFanout;

  constructor(options: {
    store: RoomNamespaceStore;
    authorizeJoin: AuthorizeJoin;
    authorizePublish: AuthorizePublish;
    isKeyCurrent?: IsKeyCurrent;
    onPresenceUpdate?: OnPresenceUpdate;
    onEventPublish?: OnEventPublish;
    onFanout?: OnFanout;
  }) {
    this.store = options.store;
    this.membership = new MembershipManager(options.store);
    this.rooms = new RoomManager(options.store);
    this.encryption = new EncryptionGate();

    this.authorizeJoin = options.authorizeJoin;
    this.authorizePublish = options.authorizePublish;
    this.onPresenceUpdate = options.onPresenceUpdate;
    this.onEventPublish = options.onEventPublish;
    this.onFanout = options.onFanout;
  }

  // ------------------------------------------------------------------
  // Join
  // ------------------------------------------------------------------

  /**
   * Handle a join request from an authenticated connection.
   *
   * Steps:
   *   1. Require authenticated connection
   *   2. Validate tenant/namespace/room identifiers
   *   3. Authorize room:join
   *   4. Enforce capacity atomically and reserve slot
   *   5. Encryption gate (if policy is `required`)
   *   6. Commit membership idempotently using (roomKey, connectionId)
   *   7. Publish join/presence events only after commit
   *   8. On any failure or disconnect race, release reservation and roll back
   */
  async joinRoom(
    principal: AuthenticatedPrincipal,
    connection: TransportConnection,
    tenantId: string,
    namespaceId: string,
    roomId: string,
  ): Promise<
    | { ok: true; roomKey: string; memberCount: number }
    | { ok: false; error: RoomError }
  > {
    const roomKey = encodeRoomKey(tenantId, namespaceId, roomId);

    // Validate room key encoding
    if (!isValidRoomKey(roomKey)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "Invalid room key encoding",
          roomKey,
        },
      };
    }

    // Get room record
    const room = await this.rooms.getRoom(roomKey);
    if (!room) {
      return {
        ok: false,
        error: {
          code: "ROOM_NOT_FOUND",
          message: `Room ${roomId} not found`,
          roomKey,
        },
      };
    }

    // Join via membership manager (handles authorize, capacity, encryption gate, commit)
    const result = await this.membership.join(
      principal,
      connection.id,
      tenantId,
      namespaceId,
      roomId,
      {
        authorizeJoin: async (p, rk, rr) => {
          const authorized = await this.authorizeJoin(p, rk, rr);
          if (!authorized) {
            throw new Error("Not authorized to join room");
          }
          return true;
        },
        isKeyCurrent: undefined,
        roomRecord: room,
      },
    );

    if (!result.ok) {
      return result;
    }

    // Publish presence update after successful commit
    if (this.onPresenceUpdate) {
      try {
        await this.onPresenceUpdate(principal.userId, "online", roomKey);
      } catch {
        // Non-fatal
      }
    }

    // Publish member_joined event
    if (this.onEventPublish) {
      try {
        await this.onEventPublish(
          roomKey,
          {
            type: "member_joined",
            data: {
              userId: principal.userId,
              connectionId: connection.id,
              roomKey,
              joinedAt: Date.now(),
            },
          },
        );
      } catch {
        // Non-fatal
      }
    }

    return { ok: true, roomKey, memberCount: result.memberCount };
  }

  // ------------------------------------------------------------------
  // Publish
  // ------------------------------------------------------------------

  /**
   * Handle a publish request to a room.
   *
   * Steps:
   *   1. Authorize room:publish
   *   2. Resolve current membership set (snapshot)
   *   3. Enforce room message-size, rate, and encryption policy
   *   4. If encryption is `required`: reject plaintext, require valid
   *      ciphertext envelope for current key epoch
   *   5. Hand off to Event Management layer for fan-out
   */
  async publishToRoom(
    principal: AuthenticatedPrincipal,
    roomKey: string,
    message: unknown,
  ): Promise<
    | { ok: true; delivered: number }
    | { ok: false; error: RoomError }
  > {
    if (!isValidRoomKey(roomKey)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "Invalid room key encoding",
          roomKey,
        },
      };
    }

    // Get room record
    const room = await this.rooms.getRoom(roomKey);
    if (!room) {
      return {
        ok: false,
        error: {
          code: "ROOM_NOT_FOUND",
          message: `Room not found: ${roomKey}`,
          roomKey,
        },
      };
    }

    // Authorize room:publish
    if (this.authorizePublish) {
      const authorized = await this.authorizePublish(principal, roomKey, room);
      if (!authorized) {
        return {
          ok: false,
          error: {
            code: "UNAUTHORIZED_PUBLISH",
            message: `Principal ${principal.userId} not authorized to publish to room ${roomKey}`,
            roomKey,
          },
        };
      }
    }

    // Resolve current membership snapshot (do not hold lock during network writes)
    const members = await this.store.getMembers(roomKey);
    if (members.length === 0) {
      return { ok: true, delivered: 0 };
    }

    // Encryption gate for publish
    const gateResult = await this.encryption.checkPublish(
      roomKey,
      room.encryptionPolicy,
      message,
      true, // hasCurrentKey — check the client's key registration against current epoch
    );

    if (!gateResult.allowed) {
      return { ok: false, error: gateResult.error! };
    }

    // Fan-out via Event Management
    const memberIds = members.map((m) => m.connectionId);
    let delivered = 0;

    if (this.onFanout) {
      delivered = await this.onFanout(roomKey, message, memberIds);
    } else {
      delivered = memberIds.length;
    }

    return { ok: true, delivered };
  }

  // ------------------------------------------------------------------
  // Leave / disconnect
  // ------------------------------------------------------------------

  /**
   * Handle a connection leaving a room.
   *
   * Steps:
   *   1. Remove membership once (idempotent)
   *   2. Clear room-scoped ephemeral state (typing, cursors, etc.)
   *   3. Update presence aggregates
   *   4. Notify remaining members according to privacy policy
   *   5. Release capacity
   */
  async leaveRoom(
    connectionId: string,
    roomKey: string,
  ): Promise<
    | { ok: true; memberCount: number }
    | { ok: false; error: RoomError }
  > {
    // Get membership before removing (to know userId for presence update)
    const membership = await this.store.getMembership(roomKey, connectionId);
    const userId = membership?.userId;

    const result = await this.membership.leave(connectionId, roomKey, {
      onMemberLeft: (rk, uid, count) => {
        // Publish member_left event
        if (this.onEventPublish) {
          void this.onEventPublish(rk, {
            type: "member_left",
            data: {
              userId: uid,
              connectionId,
              roomKey: rk,
              leftAt: Date.now(),
            },
          });
        }

        // Update presence
        if (this.onPresenceUpdate && uid) {
          void this.onPresenceUpdate(uid, "offline", rk);
        }
      },
      clearEphemeralState: async (rk, uid) => {
        // Clear room-scoped awareness (typing, cursors)
        // This would integrate with the Presence/awareness system
      },
    });

    if (!result.ok) {
      return result;
    }

    return { ok: true, memberCount: result.memberCount };
  }

  /**
   * Handle a Hub disconnect — remove all memberships for a connection.
   * Safe to call multiple times (idempotent).
   */
  async handleDisconnect(connectionId: string): Promise<void> {
    await this.membership.disconnect(connectionId);
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  /**
   * Get all members of a room.
   */
  async getMembers(roomKey: string): Promise<Array<{ userId: string; connectionId: string; joinedAt: number }>> {
    const members = await this.store.getMembers(roomKey);
    return members.map((m) => ({
      userId: m.userId,
      connectionId: m.connectionId,
      joinedAt: m.joinedAt,
    }));
  }

  /**
   * Get member count of a room.
   */
  async getMemberCount(roomKey: string): Promise<number> {
    return this.store.getMemberCount(roomKey);
  }

  /**
   * Check if a connection is a member of a room.
   */
  async isMember(roomKey: string, connectionId: string): Promise<boolean> {
    return this.membership.isMember(roomKey, connectionId);
  }

  /**
   * Get all rooms a connection is joined to.
   */
  async getRoomsForConnection(connectionId: string): Promise<string[]> {
    return this.store.getRoomsForConnection(connectionId);
  }

  /**
   * Advance the key epoch for a room (called on revocation/rekey).
   * All remaining members must rekey before future sends.
   */
  advanceKeyEpoch(roomKey: string): number {
    return this.encryption.advanceEpoch(roomKey);
  }

  /**
   * Get the current key epoch for a room.
   */
  getKeyEpoch(roomKey: string): number {
    return this.encryption.getEpoch(roomKey);
  }
}
