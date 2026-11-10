/**
 * Device identity manager — reference implementation.
 *
 * docs/e2ee/e2ee-architecture-plan.md §5.1: the device identity manager
 * creates device identity, registers signed public identity/pre-key
 * records, verifies account/device bindings and trust state, and tracks
 * active, revoked, and superseded devices.
 *
 * This is an in-memory reference; production deployments should back it
 * with platform-protected storage (docs §9) and a persistence layer.
 */

import sodium from "libsodium-wrappers";
import type {
  DeviceIdentity,
  DeviceIdentityManager,
  SignedDeviceRecord,
  TrustResult,
  TrustState,
} from "./types.js";
import {
  generateKeyPair,
  generateSigningKeyPair,
  isE2EEReady,
  sign,
  toBase64,
  verify,
} from "./primitives.js";
import { canonicalDeviceRecordBytes } from "./canonical.js";

function assertReady(): void {
  if (!isE2EEReady()) {
    throw new Error("libsodium is not ready yet. Await e2eeReady() first.");
  }
}

/**
 * In-memory device identity manager. Suitable for tests and as a scaffold
 * for a production store. Private keys are held in memory only; production
 * must use platform-protected storage (Web Crypto non-extractable keys,
 * Keychain, Keystore).
 */
export class MemoryDeviceIdentityManager implements DeviceIdentityManager {
  private readonly devices = new Map<string, {
    identity: DeviceIdentity;
    trust: TrustState;
    signedRecord: SignedDeviceRecord;
  }>();
  private readonly accountDevices = new Map<string, Set<string>>();

  constructor(private readonly accountId: string) {}

  async initialize(): Promise<DeviceIdentity> {
    assertReady();
    const box = generateKeyPair();
    const signing = generateSigningKeyPair();
    const identity: DeviceIdentity = {
      deviceId: crypto.randomUUID(),
      x25519PublicKey: box.publicKey,
      x25519PrivateKey: box.privateKey,
      ed25519PublicKey: signing.publicKey,
      ed25519PrivateKey: signing.privateKey,
    };

    const record = this.signRecord(identity);
    this.devices.set(identity.deviceId, {
      identity,
      trust: "pending",
      signedRecord: record,
    });
    let set = this.accountDevices.get(this.accountId);
    if (!set) {
      set = new Set();
      this.accountDevices.set(this.accountId, set);
    }
    set.add(identity.deviceId);

    return identity;
  }

  async getPublicDeviceRecord(): Promise<SignedDeviceRecord> {
    const [deviceId] = this.accountDevices.get(this.accountId) ?? [];
    if (!deviceId) {
      throw new Error("No device initialized for this account");
    }
    return this.devices.get(deviceId)!.signedRecord;
  }

  async verifyDeviceRecord(record: SignedDeviceRecord): Promise<TrustResult> {
    assertReady();
    const device = [...this.devices.values()].find(
      (d) => d.signedRecord.deviceId === record.deviceId,
    );

    if (!device) {
      return { deviceId: record.deviceId, trust: "unknown", reason: "No record on file" };
    }

    // Verify the record signature against the stored Ed25519 public key.
    // `sign()` returns `signature(64) || message`; `verify()` expects that
    // concatenated form, so reconstruct it before verifying.
    const messageBytes = Buffer.from(
      canonicalDeviceRecordBytes({
        deviceId: record.deviceId,
        accountId: record.accountId,
        x25519PublicKey: Buffer.from(record.x25519PublicKey, "base64"),
        ed25519PublicKey: Buffer.from(record.ed25519PublicKey, "base64"),
      }),
    );
    const signatureBytes = Buffer.from(record.signature, "base64");
    let valid = false;
    try {
      verify(
        Buffer.concat([signatureBytes, messageBytes]),
        Buffer.from(device.identity.ed25519PublicKey),
      );
      valid = true;
    } catch {
      // Signature verification failed (tampered record / key substitution).
      valid = false;
    }

    if (!valid) {
      return { deviceId: record.deviceId, trust: "unknown", reason: "Signature verification failed" };
    }

    return {
      deviceId: record.deviceId,
      trust: device.trust,
      reason: device.trust === "revoked" ? "Device is revoked" : undefined,
    };
  }

  async approveDevice(deviceId: string, _proof?: unknown): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(`Unknown device: ${deviceId}`);
    }
    device.trust = "trusted";
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(`Unknown device: ${deviceId}`);
    }
    device.trust = "revoked";
  }

  async getTrustState(deviceId: string): Promise<TrustState> {
    const device = this.devices.get(deviceId);
    return device ? device.trust : "unknown";
  }

  /** Test-only: list device ids for this account. */
  deviceIds(): string[] {
    return [...(this.accountDevices.get(this.accountId) ?? [])];
  }

  /** Test-only: get a device's X25519 public key. */
  x25519PublicKey(deviceId: string): Uint8Array | undefined {
    return this.devices.get(deviceId)?.identity.x25519PublicKey;
  }

  /** Test-only: get a device's Ed25519 public key. */
  ed25519PublicKey(deviceId: string): Uint8Array | undefined {
    return this.devices.get(deviceId)?.identity.ed25519PublicKey;
  }

  private signRecord(identity: DeviceIdentity): SignedDeviceRecord {
    const x25519PublicKeyBuf = Buffer.from(identity.x25519PublicKey);
    const ed25519PublicKeyBuf = Buffer.from(identity.ed25519PublicKey);
    const record: SignedDeviceRecord = {
      deviceId: identity.deviceId,
      x25519PublicKey: toBase64(x25519PublicKeyBuf),
      ed25519PublicKey: toBase64(ed25519PublicKeyBuf),
      accountId: this.accountId,
      signature: "", // filled below
    };
    const messageBytes = Buffer.from(
      canonicalDeviceRecordBytes({
        deviceId: record.deviceId,
        accountId: record.accountId,
        x25519PublicKey: x25519PublicKeyBuf,
        ed25519PublicKey: ed25519PublicKeyBuf,
      }),
    );
    const signed = sign(
      messageBytes,
      Buffer.from(identity.ed25519PrivateKey),
    );
    // `sign()` returns `signature(64) || message`; store only the signature.
    record.signature = toBase64(
      Buffer.from(signed.subarray(0, sodium.crypto_sign_BYTES)),
    );
    return record;
  }
}
