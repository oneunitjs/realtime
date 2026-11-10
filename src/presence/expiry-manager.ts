/**
 * Expiry Manager — Expiry worker for detecting and removing stale leases.
 *
 * Periodically checks for device leases that have passed their expiry
 * deadline plus grace period. Removes expired leases, recalculates user
 * aggregates, and publishes meaningful changes.
 *
 * Production requirements:
 *   - Atomic expiry claims
 *   - Idempotent processing
 *   - Per-user serialization or versioned CAS updates
 *   - Bounded batch sizes
 *   - No timer allocation per user/device
 *   - Cleanup of connection mappings and indexes
 */

import type {
  InternalDeviceLease,
  PresenceConfig,
  PresenceStore,
} from "./types.js";
import { isLeaseExpired, leaseToDevicePresence } from "./lease-manager.js";
import { buildUserPresence, presenceChanged } from "./aggregation-manager.js";

// ---------------------------------------------------------------------------
// Expiry Worker
// ---------------------------------------------------------------------------

/**
 * Expiry worker that runs on a timer to detect and remove expired leases.
 *
 * The worker finds all leases past their expiry deadline, removes them,
 * recalculates affected user aggregates, and publishes changes.
 */
export class ExpiryManager {
  private readonly store: PresenceStore;
  private readonly config: PresenceConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly onLeaseExpired: (lease: InternalDeviceLease) => void;
  private readonly onUserAggregate: (
    userId: string,
    tenantId: string,
    aggregate: { status: string; devices: unknown[]; updatedAt: number },
  ) => void;

  constructor(
    store: PresenceStore,
    config: PresenceConfig,
    callbacks: {
      onLeaseExpired: (lease: InternalDeviceLease) => void;
      onUserAggregate: (
        userId: string,
        tenantId: string,
        aggregate: {
          status: string;
          devices: unknown[];
          updatedAt: number;
        },
      ) => void;
    },
  ) {
    this.store = store;
    this.config = config;
    this.onLeaseExpired = callbacks.onLeaseExpired;
    this.onUserAggregate = callbacks.onUserAggregate;
  }

  /** Start the expiry worker timer. */
  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.processExpiredLeases();
    }, this.config.expiryWorkerIntervalMs);

    this.timer.unref?.();
  }

  /** Stop the expiry worker timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Process all expired leases in one batch. */
  async processExpiredLeases(): Promise<void> {
    if (this.running) {
      return; // Prevent concurrent runs
    }

    this.running = true;

    try {
      const expiredLeases = await this.store.findExpiredLeases();

      // Group by user for aggregate recalculation
      const usersToRecalculate = new Map<string, InternalDeviceLease[]>();

      for (const lease of expiredLeases) {
        if (isLeaseExpired(lease, this.config.expiryGraceMs)) {
          await this.store.removeLease(lease.deviceId);
          this.onLeaseExpired(lease);

          const key = `${lease.tenantId ?? ""}:${lease.userId}`;
          const existing = usersToRecalculate.get(key) ?? [];
          existing.push(lease);
          usersToRecalculate.set(key, existing);
        }
      }

      // Recalculate aggregates for affected users
      for (const [key, leases] of usersToRecalculate) {
        const [tenantId, userId] = key.split(":") as [string, string];
        const remainingLeases = await this.store.getUserLeases(userId, tenantId);

        const aggregate = buildUserPresence(userId, remainingLeases, {
          omitOfflineUsers: this.config.omitOfflineUsers,
          tenantId,
        });

        this.onUserAggregate(userId, tenantId, {
          status: aggregate.status,
          devices: aggregate.devices,
          updatedAt: aggregate.updatedAt,
        });
      }
    } catch (error) {
      // Expiry worker failures should not crash the process
      // Log and continue — the next cycle will pick up expired leases
      console.error("Expiry worker error:", error);
    } finally {
      this.running = false;
    }
  }

  /** Run one expiry pass immediately (useful for tests). */
  async sweep(): Promise<void> {
    await this.processExpiredLeases();
  }

  /** Check if the worker is currently running. */
  isRunning(): boolean {
    return this.running;
  }
}
