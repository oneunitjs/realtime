/**
 * Namespace Manager — Namespace CRUD and policy enforcement.
 *
 * Namespaces provide isolation and policy boundaries for logical
 * application areas or tenant features.
 */

import type {
  NamespaceRecord,
  RoomNamespaceLimits,
  RoomNamespaceStore,
} from "./types.js";
import { DEFAULT_ROOM_NAMESPACE_LIMITS } from "./types.js";

// ---------------------------------------------------------------------------
// Namespace Manager
// ---------------------------------------------------------------------------

export class NamespaceManager {
  private readonly store: RoomNamespaceStore;
  private readonly limits: RoomNamespaceLimits;
  private readonly namespaces = new Map<string, NamespaceRecord>(); // cache: "tenantId:namespaceId" -> record

  constructor(
    store: RoomNamespaceStore,
    limits: Partial<RoomNamespaceLimits> = {},
  ) {
    this.store = store;
    this.limits = { ...DEFAULT_ROOM_NAMESPACE_LIMITS, ...limits };
  }

  // ------------------------------------------------------------------
  // Namespace CRUD
  // ------------------------------------------------------------------

  /**
   * Get a namespace by tenant and namespace ID.
   */
  async getNamespace(
    tenantId: string,
    namespaceId: string,
  ): Promise<NamespaceRecord | null> {
    const cacheKey = `${tenantId}:${namespaceId}`;
    const cached = this.namespaces.get(cacheKey);
    if (cached) {
      return cached;
    }

    const record = await this.store.getNamespace(tenantId, namespaceId);
    if (record) {
      this.namespaces.set(cacheKey, record);
    }
    return record;
  }

  /**
   * Create a new namespace.
   *
   * Enforces maxNamespacesPerTenant limit.
   */
  async createNamespace(record: NamespaceRecord): Promise<void> {
    const existing = await this.store.getNamespace(
      record.tenantId,
      record.namespaceId,
    );
    if (existing) {
      throw new Error(`Namespace ${record.namespaceId} already exists in tenant ${record.tenantId}`);
    }

    // Enforce max namespaces per tenant
    const tenantNamespaces = await this.store.listNamespaces(record.tenantId);
    if (tenantNamespaces.length >= this.limits.maxNamespacesPerTenant) {
      throw new Error(
        `Tenant ${record.tenantId} has reached the namespace limit of ${this.limits.maxNamespacesPerTenant}`,
      );
    }

    await this.store.createNamespace(record);
    this.namespaces.set(`${record.tenantId}:${record.namespaceId}`, record);
  }

  /**
   * Delete a namespace. All rooms within it should be deleted first.
   */
  async deleteNamespace(
    tenantId: string,
    namespaceId: string,
  ): Promise<void> {
    const rooms = await this.store.listRooms(tenantId, namespaceId);
    if (rooms.length > 0) {
      throw new Error(
        `Cannot delete namespace ${namespaceId}: ${rooms.length} rooms still exist. Delete all rooms first.`,
      );
    }

    await this.store.deleteNamespace(tenantId, namespaceId);
    this.namespaces.delete(`${tenantId}:${namespaceId}`);
  }

  /**
   * List all namespaces for a tenant.
   */
  async listNamespaces(tenantId: string): Promise<NamespaceRecord[]> {
    return this.store.listNamespaces(tenantId);
  }

  /**
   * Check if a namespace exists.
   */
  async namespaceExists(
    tenantId: string,
    namespaceId: string,
  ): Promise<boolean> {
    return (await this.getNamespace(tenantId, namespaceId)) !== null;
  }
}
