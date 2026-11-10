/**
 * Presence store adapter integration tests.
 *
 * Exercises `PresenceService` against an in-memory `PresenceStore`:
 * lease creation on connect, refresh on heartbeat, removal on disconnect,
 * and expiry sweep removing stale leases.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PresenceService } from "../../../src/presence/service.js";
import type {
  InternalDeviceLease,
  PresenceStore,
  AuthenticatedPrincipal,
} from "../../../src/presence/types.js";

class InMemoryPresenceStore implements PresenceStore {
  private leases = new Map<string, InternalDeviceLease>();

  async createOrRefreshLease(lease: InternalDeviceLease): Promise<void> {
    this.leases.set(lease.deviceId, lease);
  }
  async getLease(deviceId: string): Promise<InternalDeviceLease | null> {
    return this.leases.get(deviceId) ?? null;
  }
  async getUserLeases(userId: string, tenantId: string): Promise<InternalDeviceLease[]> {
    return [...this.leases.values()].filter((l) => l.userId === userId && l.tenantId === tenantId);
  }
  async removeLease(deviceId: string): Promise<void> {
    this.leases.delete(deviceId);
  }
  async findExpiredLeases(): Promise<InternalDeviceLease[]> {
    const now = Date.now();
    return [...this.leases.values()].filter((l) => l.expiresAt < now);
  }
  async addRoomMembership(): Promise<void> {
    return;
  }
  async removeRoomMembership(): Promise<void> {
    return;
  }
  async getRoomMembers(): Promise<import("../../../src/presence/types.js").PresenceRoomMembership[]> {
    return [];
  }
  async close(): Promise<void> {
    this.leases.clear();
  }
}

function leaseFor(deviceId: string, overrides: Partial<InternalDeviceLease> = {}): InternalDeviceLease {
  const now = Date.now();
  return {
    tenantId: "tenant-a",
    userId: "alice",
    deviceId,
    connectionId: `conn-${deviceId}`,
    status: "online",
    lastSeenAt: now,
    expiresAt: now + 75_000,
    version: 1,
    ...overrides,
  };
}

describe("presence store adapter", () => {
  let store: InMemoryPresenceStore;
  let service: PresenceService;

  beforeEach(() => {
    store = new InMemoryPresenceStore();
    service = new PresenceService({ store });
  });

  afterEach(async () => {
    await store.close();
  });

  it("creates a lease and online aggregate on connect", async () => {
    const principal: AuthenticatedPrincipal = {
      userId: "alice",
      tenantId: "tenant-a",
      roles: ["user"],
      sessionId: "s1",
    };
    const aggregate = await service.connect(principal, {
      connectionId: "conn-1",
      deviceId: "device-1",
    });

    expect(aggregate.status).toBe("online");
    const lease = await store.getLease("device-1");
    expect(lease).not.toBeNull();
    expect(lease?.deviceId).toBe("device-1");
  });

  it("refreshes the lease on heartbeat", async () => {
    const principal: AuthenticatedPrincipal = {
      userId: "alice",
      tenantId: "tenant-a",
      roles: ["user"],
      sessionId: "s1",
    };
    await service.connect(principal, { connectionId: "conn-1", deviceId: "device-1" });

    const before = await store.getLease("device-1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await service.heartbeat("conn-1");
    const after = await store.getLease("device-1");

    expect(after?.expiresAt).toBeGreaterThanOrEqual(before?.expiresAt ?? 0);
  });

  it("removes the lease and marks the user offline on disconnect", async () => {
    const principal: AuthenticatedPrincipal = {
      userId: "alice",
      tenantId: "tenant-a",
      roles: ["user"],
      sessionId: "s1",
    };
    await service.connect(principal, { connectionId: "conn-1", deviceId: "device-1" });
    expect((await store.getLease("device-1"))).not.toBeNull();

    const aggregate = await service.disconnect("conn-1");
    expect((await store.getLease("device-1"))).toBeNull();
    expect(aggregate).not.toBeNull();
    expect(aggregate!.status).toBe("offline");
  });

  it("sweepExpiry removes leases past their expiry", async () => {
    const expired = leaseFor("device-stale", { expiresAt: Date.now() - 30_000 });
    await store.createOrRefreshLease(expired);
    const live = leaseFor("device-live");
    await store.createOrRefreshLease(live);

    await service.sweepExpiry();

    expect((await store.getLease("device-stale"))).toBeNull();
    expect((await store.getLease("device-live"))).not.toBeNull();
  });
});
