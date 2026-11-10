import { describe, it, expect } from "vitest";
import sodium from "libsodium-wrappers";
import {
  generateKeyPair,
  generateSigningKeyPair,
  encrypt,
  decrypt,
  sign,
  verify,
  computeSharedKey,
  encryptWithSharedKey,
  decryptWithSharedKey,
  toBase64,
  fromBase64,
  keyToHex,
  keyFromHex,
  isE2EEReady,
} from "../../src/e2ee/primitives.js";

await sodium.ready;

describe("E2EE", () => {
  it("generateKeyPair returns matching public and private keys", () => {
    const keyPair = generateKeyPair();
    expect(Buffer.isBuffer(keyPair.publicKey)).toBe(true);
    expect(Buffer.isBuffer(keyPair.privateKey)).toBe(true);
    expect(keyPair.publicKey.length).toBe(sodium.crypto_box_PUBLICKEYBYTES);
    expect(keyPair.privateKey.length).toBe(sodium.crypto_box_SECRETKEYBYTES);
  });

  it("generateSigningKeyPair returns matching signing keys", () => {
    const keyPair = generateSigningKeyPair();
    expect(Buffer.isBuffer(keyPair.publicKey)).toBe(true);
    expect(Buffer.isBuffer(keyPair.privateKey)).toBe(true);
    expect(keyPair.publicKey.length).toBe(sodium.crypto_sign_PUBLICKEYBYTES);
    expect(keyPair.privateKey.length).toBe(sodium.crypto_sign_SECRETKEYBYTES);
  });

  it("encrypt and decrypt round-trip", () => {
    const sender = generateKeyPair();
    const recipient = generateKeyPair();
    const message = Buffer.from("hello world");

    const ciphertext = encrypt(message, recipient.publicKey, sender.privateKey);
    const decrypted = decrypt(ciphertext, sender.publicKey, recipient.privateKey);

    expect(decrypted).toEqual(message);
  });

  it("decrypt fails with wrong key", () => {
    const sender = generateKeyPair();
    const recipient = generateKeyPair();
    const wrongRecipient = generateKeyPair();
    const message = Buffer.from("secret");

    const ciphertext = encrypt(message, recipient.publicKey, sender.privateKey);

    expect(() => decrypt(ciphertext, sender.publicKey, wrongRecipient.privateKey)).toThrow();
  });

  it("sign and verify round-trip", () => {
    const keyPair = generateSigningKeyPair();
    const message = Buffer.from("signed message");

    const signed = sign(message, keyPair.privateKey);
    const verified = verify(signed, keyPair.publicKey);

    expect(verified).toEqual(message);
  });

  it("verify fails with wrong key", () => {
    const sender = generateSigningKeyPair();
    const recipient = generateSigningKeyPair();
    const message = Buffer.from("signed message");

    const signed = sign(message, sender.privateKey);

    expect(() => verify(signed, recipient.publicKey)).toThrow();
  });

  it("computeSharedKey derives matching shared keys", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();

    const aliceShared = computeSharedKey(bob.publicKey, alice.privateKey);
    const bobShared = computeSharedKey(alice.publicKey, bob.privateKey);

    expect(aliceShared).toEqual(bobShared);
  });

  it("encryptWithSharedKey and decryptWithSharedKey round-trip", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();

    const aliceShared = computeSharedKey(bob.publicKey, alice.privateKey);
    const bobShared = computeSharedKey(alice.publicKey, bob.privateKey);

    const message = Buffer.from("shared secret message");
    const ciphertext = encryptWithSharedKey(message, aliceShared);
    const decrypted = decryptWithSharedKey(ciphertext, bobShared);

    expect(decrypted).toEqual(message);
  });

  it("toBase64 and fromBase64 round-trip", () => {
    const buffer = Buffer.from("test data");
    const base64 = toBase64(buffer);
    const decoded = fromBase64(base64);
    expect(decoded).toEqual(buffer);
  });

  it("keyToHex and keyFromHex round-trip", () => {
    const keyPair = generateKeyPair();
    const hex = keyToHex(keyPair.publicKey);
    const restored = keyFromHex(hex);
    expect(restored).toEqual(keyPair.publicKey);
  });

  it("reports readiness once libsodium is initialized", () => {
    expect(isE2EEReady()).toBe(true);
  });

  it("rejects a truncated public key", () => {
    const sender = generateKeyPair();
    const recipient = generateKeyPair();
    const truncated = recipient.publicKey.subarray(0, 8);

    expect(() => encrypt(Buffer.from("x"), truncated, sender.privateKey)).toThrow(
      /recipientPublicKey must be 32 bytes/,
    );
  });

  it("rejects a truncated private key", () => {
    const recipient = generateKeyPair();

    expect(() => computeSharedKey(recipient.publicKey, Buffer.alloc(4))).toThrow(
      /senderPrivateKey must be 32 bytes/,
    );
  });

  it("rejects a shared key of the wrong length", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const sharedKey = computeSharedKey(bob.publicKey, alice.privateKey);

    expect(() => encryptWithSharedKey(Buffer.from("x"), sharedKey.subarray(0, 4))).toThrow(
      /sharedKey must be 32 bytes/,
    );
  });

  it("rejects a ciphertext that is too short to contain a nonce and tag", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const sharedKey = computeSharedKey(bob.publicKey, alice.privateKey);

    expect(() => decryptWithSharedKey(Buffer.alloc(8), sharedKey)).toThrow(
      /at least 40 bytes/,
    );
  });

  it("rejects a non-Buffer message", () => {
    const sender = generateKeyPair();
    const recipient = generateKeyPair();

    expect(() =>
      encrypt("plain text" as unknown as Buffer, recipient.publicKey, sender.privateKey),
    ).toThrow(/message must be a Buffer/);
  });

  it("rejects malformed base64 and hex input", () => {
    expect(() => fromBase64("***not base64***")).toThrow(/not valid base64/);
    expect(() => keyFromHex("zzzz")).toThrow(/not valid hexadecimal/);
    expect(() => keyFromHex("abc")).toThrow(/not valid hexadecimal/);
    expect(() => toBase64("nope" as unknown as Buffer)).toThrow(/must be a Buffer/);
  });

  it("encrypts the same plaintext differently on every call", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const sharedKey = computeSharedKey(bob.publicKey, alice.privateKey);
    const message = Buffer.from("same input");

    const first = encryptWithSharedKey(message, sharedKey);
    const second = encryptWithSharedKey(message, sharedKey);

    expect(first.equals(second)).toBe(false);
    expect(decryptWithSharedKey(first, sharedKey)).toEqual(message);
    expect(decryptWithSharedKey(second, sharedKey)).toEqual(message);
  });
});