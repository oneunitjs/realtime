/**
 * Key directory — reference implementation.
 *
 * docs/e2ee/e2ee-architecture-plan.md §5.2: a service/API that publishes
 * public device records and signed key-change statements. Clients fetch
 * records for recipients, verify signatures and account/device binding,
 * check revocation and current key epoch, and must not blindly trust a key
 * because it came from the Hub.
 *
 * This is an in-memory reference; production should back it with a
 * persistence layer and, optionally, an auditable transparency directory.
 */

import type { KeyDirectory, SignedDeviceRecord } from "./types.js";

export class MemoryKeyDirectory implements KeyDirectory {
  private readonly records = new Map<string, Map<string, SignedDeviceRecord>>(); // accountId -> deviceId -> record

  async publishRecord(record: SignedDeviceRecord): Promise<void> {
    let byDevice = this.records.get(record.accountId);
    if (!byDevice) {
      byDevice = new Map();
      this.records.set(record.accountId, byDevice);
    }
    byDevice.set(record.deviceId, record);
  }

  async fetchRecord(
    accountId: string,
    deviceId: string,
  ): Promise<SignedDeviceRecord | null> {
    const byDevice = this.records.get(accountId);
    return byDevice ? (byDevice.get(deviceId) ?? null) : null;
  }

  async fetchAccountRecords(accountId: string): Promise<SignedDeviceRecord[]> {
    const byDevice = this.records.get(accountId);
    return byDevice ? [...byDevice.values()] : [];
  }

  async revokeRecord(accountId: string, deviceId: string): Promise<void> {
    const byDevice = this.records.get(accountId);
    if (byDevice) {
      byDevice.delete(deviceId);
    }
  }

  /** Test-only: all records for an account. */
  recordsFor(accountId: string): SignedDeviceRecord[] {
    const byDevice = this.records.get(accountId);
    return byDevice ? [...byDevice.values()] : [];
  }
}
