import sodium from "libsodium-wrappers";
export interface KeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
}

export interface SharedKeyData {
  publicKey: Buffer;
  sharedKey: Buffer;
}

const NOT_READY_MESSAGE =
  "libsodium is still initializing. Await e2eeReady() before using E2EE helpers " +
  "(registerRealtime() already awaits it for you).";

let initialized = false;

const readiness: Promise<void> = sodium.ready.then(() => {
  initialized = true;
});

export function e2eeReady(): Promise<void> {
  return readiness;
}

export function isE2EEReady(): boolean {
  if (!initialized) {
    initialized = typeof sodium.crypto_box_keypair === "function";
  }

  return initialized;
}

function assertReady(): void {
  if (!initialized) {
    throw new Error(NOT_READY_MESSAGE);
  }
}

function assertBuffer(value: unknown, name: string): Buffer {
  if (!Buffer.isBuffer(value)) {
    throw new TypeError(`${name} must be a Buffer`);
  }
  return value;
}

function assertLength(value: Buffer, expected: number, name: string): Buffer {
  if (value.length !== expected) {
    throw new RangeError(
      `${name} must be ${expected} bytes, received ${value.length}`,
    );
  }
  return value;
}

/**
 * Validate a peer public key received from the wire.
 *
 * Separate from {@link assertBoxPublicKey} because this is the boundary check: a
 * key arriving from a client is untrusted input, and a wrong length has to fail
 * loudly at registration instead of surfacing later as a `RangeError` from deep
 * inside a broadcast.
 */
export function assertClientPublicKey(publicKey: unknown, name = "publicKey"): Buffer {
  const key = assertBuffer(publicKey, name);

  if (key.length !== sodium.crypto_box_PUBLICKEYBYTES) {
    throw new RangeError(
      `${name} must be ${sodium.crypto_box_PUBLICKEYBYTES} bytes, received ${key.length}`,
    );
  }

  return key;
}

function assertBoxPublicKey(key: unknown, name = "publicKey"): Buffer {
  return assertLength(
    assertBuffer(key, name),
    sodium.crypto_box_PUBLICKEYBYTES,
    name,
  );
}

function assertBoxPrivateKey(key: unknown, name = "privateKey"): Buffer {
  return assertLength(
    assertBuffer(key, name),
    sodium.crypto_box_SECRETKEYBYTES,
    name,
  );
}

function assertSharedKey(key: unknown, name = "sharedKey"): Buffer {
  return assertLength(
    assertBuffer(key, name),
    sodium.crypto_box_BEFORENMBYTES,
    name,
  );
}

function splitCiphertext(
  ciphertext: unknown,
  name: string,
): { nonce: Buffer; body: Buffer } {
  const buffer = assertBuffer(ciphertext, name);
  const nonceSize = sodium.crypto_box_NONCEBYTES;
  const minimum = nonceSize + sodium.crypto_box_MACBYTES;

  if (buffer.length < minimum) {
    throw new RangeError(
      `${name} must be at least ${minimum} bytes (nonce + authentication tag), received ${buffer.length}`,
    );
  }

  return {
    nonce: buffer.subarray(0, nonceSize),
    body: buffer.subarray(nonceSize),
  };
}

export function generateKeyPair(): KeyPair {
  assertReady();
  const keyPair = sodium.crypto_box_keypair();
  return {
    publicKey: Buffer.from(keyPair.publicKey),
    privateKey: Buffer.from(keyPair.privateKey),
  };
}

export function generateSigningKeyPair(): KeyPair {
  assertReady();
  const keyPair = sodium.crypto_sign_keypair();
  return {
    publicKey: Buffer.from(keyPair.publicKey),
    privateKey: Buffer.from(keyPair.privateKey),
  };
}

export function encrypt(
  message: Buffer,
  recipientPublicKey: Buffer,
  senderPrivateKey: Buffer,
): Buffer {
  assertReady();
  const payload = assertBuffer(message, "message");
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const ciphertext = sodium.crypto_box_easy(
    payload,
    nonce,
    assertBoxPublicKey(recipientPublicKey, "recipientPublicKey"),
    assertBoxPrivateKey(senderPrivateKey, "senderPrivateKey"),
  );
  return Buffer.concat([nonce, Buffer.from(ciphertext)]);
}

export function decrypt(
  ciphertext: Buffer,
  senderPublicKey: Buffer,
  recipientPrivateKey: Buffer,
): Buffer {
  assertReady();
  const { nonce, body } = splitCiphertext(ciphertext, "ciphertext");
  const message = sodium.crypto_box_open_easy(
    body,
    nonce,
    assertBoxPublicKey(senderPublicKey, "senderPublicKey"),
    assertBoxPrivateKey(recipientPrivateKey, "recipientPrivateKey"),
  );
  return Buffer.from(message);
}

export function sign(message: Buffer, privateKey: Buffer): Buffer {
  assertReady();
  const signed = sodium.crypto_sign(
    assertBuffer(message, "message"),
    assertLength(
      assertBuffer(privateKey, "privateKey"),
      sodium.crypto_sign_SECRETKEYBYTES,
      "privateKey",
    ),
  );
  return Buffer.from(signed);
}

export function verify(signedMessage: Buffer, publicKey: Buffer): Buffer {
  assertReady();
  assertSignedMessage(signedMessage);
  const opened = sodium.crypto_sign_open(
    assertBuffer(signedMessage, "signedMessage"),
    assertLength(
      assertBuffer(publicKey, "publicKey"),
      sodium.crypto_sign_PUBLICKEYBYTES,
      "publicKey",
    ),
  );
  return Buffer.from(opened);
}

export function computeSharedKey(
  recipientPublicKey: Buffer,
  senderPrivateKey: Buffer,
): Buffer {
  assertReady();
  return Buffer.from(
    sodium.crypto_box_beforenm(
      assertBoxPublicKey(recipientPublicKey, "recipientPublicKey"),
      assertBoxPrivateKey(senderPrivateKey, "senderPrivateKey"),
    ),
  );
}

export function encryptWithSharedKey(
  message: Buffer,
  sharedKey: Buffer,
): Buffer {
  assertReady();
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const ciphertext = sodium.crypto_box_easy_afternm(
    assertBuffer(message, "message"),
    nonce,
    assertSharedKey(sharedKey),
  );
  return Buffer.concat([nonce, Buffer.from(ciphertext)]);
}

export function decryptWithSharedKey(
  ciphertext: Buffer,
  sharedKey: Buffer,
): Buffer {
  assertReady();
  const { nonce, body } = splitCiphertext(ciphertext, "ciphertext");
  const message = sodium.crypto_box_open_easy_afternm(
    body,
    nonce,
    assertSharedKey(sharedKey),
  );
  return Buffer.from(message);
}

function assertSignedMessage(signedMessage: unknown): Buffer {
  const buffer = assertBuffer(signedMessage, "signedMessage");

  if (buffer.length < sodium.crypto_sign_BYTES) {
    throw new RangeError(
      `signedMessage must be at least ${sodium.crypto_sign_BYTES} bytes, received ${buffer.length}`,
    );
  }

  return buffer;
}

export function toBase64(buffer: Uint8Array): string {
  if (!(buffer instanceof Uint8Array)) {
    throw new TypeError("buffer must be a Buffer");
  }
  return Buffer.from(buffer).toString("base64");
}

export function fromBase64(base64: string): Buffer {
  if (typeof base64 !== "string") {
    throw new TypeError("base64 must be a string");
  }

  if (base64.length > 0 && !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new TypeError("base64 is not valid base64 data");
  }

  return Buffer.from(base64, "base64");
}

export function keyToHex(buffer: Buffer): string {
  return assertBuffer(buffer, "buffer").toString("hex");
}

export function keyFromHex(hex: string): Buffer {
  if (typeof hex !== "string") {
    throw new TypeError("hex must be a string");
  }

  if (hex.length % 2 !== 0 || (hex.length > 0 && !/^[0-9a-fA-F]+$/.test(hex))) {
    throw new TypeError("hex is not valid hexadecimal data");
  }

  return Buffer.from(hex, "hex");
}
