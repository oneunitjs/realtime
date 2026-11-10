/**
 * Room Manager — Room CRUD and policy enforcement.
 *
 * Rooms are named groups of authorized connections within a namespace,
 * used for fan-out and shared presence.
 */

import type {
  RoomRecord,
  EncryptionPolicy,
  RoomNamespaceLimits,
  RoomNamespaceStore,
} from "./types.js";
import { DEFAULT_ROOM_NAMESPACE_LIMITS } from "./types.js";
import { encodeRoomKey, decodeRoomKey, isValidRoomKey } from "./room-key.js";

// ---------------------------------------------------------------------------
// Room Manager
// ---------------------------------------------------------------------------

export class RoomManager {
  private readonly store: RoomNamespaceStore;
  private readonly limits: RoomNamespaceLimits;
  private readonly rooms = new Map<string, RoomRecord>(); // cache: roomKey -> record

  constructor(
    store: RoomNamespaceStore,
    limits: Partial<RoomNamespaceLimits> = {},
  ) {
    this.store = store;
    this.limits = { ...DEFAULT_ROOM_NAMESPACE_LIMITS, ...limits };
  }

  // ------------------------------------------------------------------
  // Room CRUD
  // ------------------------------------------------------------------

  /**
   * Get a room by its canonical room key.
   */
  async getRoom(roomKey: string): Promise<RoomRecord | null> {
    if (!isValidRoomKey(roomKey)) {
      return null;
    }

    const cached = this.rooms.get(roomKey);
    if (cached) {
      return cached;
    }

    const record = await this.store.getRoom(roomKey);
    if (record) {
      this.rooms.set(roomKey, record);
    }
    return record;
  }

  /**
   * Get a room by tenant, namespace, and room ID.
   */
  async getRoomByIds(
    tenantId: string,
    namespaceId: string,
    roomId: string,
  ): Promise<RoomRecord | null> {
    const roomKey = encodeRoomKey(tenantId, namespaceId, roomId);
    return this.getRoom(roomKey);
  }

  /**
   * Create a new room.
   *
   * The room must belong to an existing namespace.
   */
  async createRoom(record: RoomRecord): Promise<void> {
    const roomKey = encodeRoomKey(
      record.tenantId,
      record.namespaceId,
      record.roomId,
    );

    const existing = await this.store.getRoom(roomKey);
    if (existing) {
      throw new Error(`Room ${record.roomId} already exists in namespace ${record.namespaceId}`);
    }

    await this.store.createRoom(record);
    this.rooms.set(roomKey, record);
  }

  /**
   * Delete a room. All memberships should be removed first.
   */
  async deleteRoom(
    tenantId: string,
    namespaceId: string,
    roomId: string,
  ): Promise<void> {
    const roomKey = encodeRoomKey(tenantId, namespaceId, roomId);

    const memberCount = await this.store.getMemberCount(roomKey);
    if (memberCount > 0) {
      throw new Error(
        `Cannot delete room ${roomId}: ${memberCount} members still joined. Remove all memberships first.`,
      );
    }

    await this.store.deleteRoom(roomKey);
    this.rooms.delete(roomKey);
  }

  /**
   * List all rooms in a namespace.
   */
  async listRooms(
    tenantId: string,
    namespaceId: string,
  ): Promise<RoomRecord[]> {
    return this.store.listRooms(tenantId, namespaceId);
  }

  /**
   * Check if a room exists.
   */
  async roomExists(
    tenantId: string,
    namespaceId: string,
    roomId: string,
  ): Promise<boolean> {
    return (await this.getRoomByIds(tenantId, namespaceId, roomId)) !== null;
  }

  /**
   * Get the encryption policy for a room.
   */
  async getEncryptionPolicy(
    tenantId: string,
    namespaceId: string,
    roomId: string,
  ): Promise<EncryptionPolicy | null> {
    const room = await this.getRoomByIds(tenantId, namespaceId, roomId);
    return room ? room.encryptionPolicy : null;
  }

  /**
   * Update a room's encryption policy.
   */
  async setEncryptionPolicy(
    tenantId: string,
    namespaceId: string,
    roomId: string,
    policy: EncryptionPolicy,
  ): Promise<void> {
    const roomKey = encodeRoomKey(tenantId, namespaceId, roomId);
    const existing = await this.store.getRoom(roomKey);
    if (!existing) {
      throw new Error(`Room ${roomId} not found`);
    }

    const updated: RoomRecord = { ...existing, encryptionPolicy: policy };
    await this.store.createRoom(updated);
    this.rooms.set(roomKey, updated);
  }
}
