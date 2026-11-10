# End-to-End Encryption (E2EE) — Architecture

**Version:** 1.0  
**Status:** Spec / Implementation Guide  
**Focus:** Web-based real-time collaboration (browser + mobile clients)  
**Last updated:** 2026-11-06  
**Related:**  
- [Core Hub Architecture](../core/core-hub.md)  
- [Collaboration Engine Architecture](../collab/collaboration-engine.md)

---

## Table of Contents

1. [What E2EE Means in This System](#1-what-e2ee-means-in-this-system)
2. [Threat Model and Honest Limits](#2-threat-model-and-honest-limits)
3. [Cryptographic Building Blocks](#3-cryptographic-building-blocks)
4. [Identity and Key Authenticity](#4-identity-and-key-authenticity)
5. [Message Envelope](#5-message-envelope)
6. [Encryption and Decryption Flow](#6-encryption-and-decryption-flow)
7. [Replay Protection, Forward Secrecy, and Groups](#7-replay-protection-forward-secrecy-and-groups)
8. [Hub Responsibilities and Metadata Leakage](#8-hub-responsibilities-and-metadata-leakage)
9. [Key Storage, Backup, and Recovery](#9-key-storage-backup-and-recovery)
10. [Integration with Hub and Collaboration Engine](#10-integration-with-hub-and-collaboration-engine)
11. [Failure Handling](#11-failure-handling)
12. [Testing and Review Requirements](#12-testing-and-review-requirements)
13. [Implementation Guidance for the Web](#13-implementation-guidance-for-the-web)
14. [Summary](#14-summary)

---

## 1. What E2EE Means in This System

**True end-to-end encryption** means:

- Only authorized **client endpoints** hold the keys that can decrypt message content.
- The Core Hub (and any intermediate servers) **route ciphertext** and never see plaintext.
- The server cannot read collaborative document content, chat messages, or awareness payloads that are marked as E2EE.

If the server can derive a shared secret, unwrap keys, or decrypt payloads for moderation, search, or indexing, the system is **server-readable encryption** (often called “encryption in transit / at rest”), **not** server-blind E2EE.

This specification chooses:

> **Client-side encryption with authenticated public-key distribution.**  
> The Hub stores and forwards opaque ciphertext plus public metadata only.

**Product rule:** UI copy, marketing, and security claims must match the actual design. Do not label a design “E2EE” if the server can decrypt.

### When E2EE is incompatible with other features

| Feature | Compatibility with server-blind E2EE |
|---------|--------------------------------------|
| Server-side search / full-text index | Incompatible (unless client-side index or trusted compute is disclosed) |
| Server-side content moderation | Incompatible (unless performed on clients or via a separately disclosed trusted-compute path) |
| Server-side CRDT validation of plaintext | Incompatible — server can only validate envelope shape, size, and authorization |
| Collaboration Engine materialization on server | Limited — server sees only ciphertext; rich server-side features require a different threat model |

If the product needs those features, either:

1. Keep those document types **out of E2EE**, or  
2. Explicitly document a **trusted-compute / server-assisted** design and never call it pure E2EE.

---

## 2. Threat Model and Honest Limits

### 2.1 What E2EE protects against

- Honest-but-curious server operators reading message content
- Database dumps of the operation log or message store revealing plaintext
- Network observers who can see ciphertext but not the keys
- Compromised transport (TLS termination points) that only see ciphertext

### 2.2 What E2EE does *not* protect against

| Risk | Reality |
|------|---------|
| Metadata | Server still sees who talks to whom, when, how often, and approximate sizes |
| Compromised client | Malware or a malicious browser extension can read plaintext after decryption |
| Key substitution if trust is weak | If the key directory can be silently altered, a malicious hub can replace keys |
| Endpoint compromise | Stolen device or unlocked browser profile exposes keys and plaintext |
| Traffic analysis | Timing and volume can leak activity patterns |

Document these limits in the security model and in user-facing help text.

---

## 3. Cryptographic Building Blocks

**Rule:** Use a maintained, audited library (e.g. libsodium, Web Crypto where appropriate, or a well-reviewed wrapper). **Do not implement primitives yourself.**

### 3.1 Recommended roles

| Primitive | Purpose | Notes |
|-----------|---------|-------|
| **X25519** | Diffie–Hellman key agreement | 32-byte public / private keys |
| **HKDF-SHA-256** | Derive purpose-specific keys from shared secrets + context | Always include protocol version and conversation IDs in context |
| **XSalsa20-Poly1305** | Encrypt / decrypt payloads | Unique nonce per key; never reuse |
| **Ed25519** | Sign identity records and key-change statements | libsodium secret keys are commonly 64 bytes — do not confuse with X25519 |
| **CSPRNG** | Keys, salts, nonces | Use the library’s secure random API |

### 3.2 Critical distinctions

- An **X25519 private key** is not an **Ed25519 signing key**. They are different algorithms and different sizes.
- A **shared secret** from key agreement is not directly usable as an AEAD key — always run it through HKDF with explicit context.
- Nonce lengths and key sizes must come from the library documentation and test vectors. Never invent them.

### 3.3 Protocol choice

- **One-to-one sessions:** Prefer a reviewed protocol that provides forward secrecy and asynchronous key agreement (e.g. a Signal-style double ratchet or a modern equivalent). Avoid long-lived static X25519 keys with no ratchet.
- **Group messaging / multi-device document collaboration:** Requires a separately reviewed **group key agreement** and a clear **membership-change rekey** mechanism. Design this deliberately; do not extend a 1:1 scheme naively.

---

## 4. Identity and Key Authenticity

A public key that arrives from the Hub is **not automatically authentic**. Without extra binding, a malicious or compromised hub can perform a **key-substitution attack**.

### 4.1 Binding keys to accounts

Choose one or more of:

| Mechanism | Description |
|-----------|-------------|
| Device-key signatures | New device key signed by an already-trusted device of the same user |
| Safety numbers / QR verification | Users compare fingerprints out-of-band |
| Organization-managed certificates | Enterprise / managed devices |
| Auditable transparency directory | Append-only log of key changes that clients can monitor |

### 4.2 Lifecycle that must be defined

- First-device enrollment
- New-device approval
- Device revocation
- Key rotation
- Recovery after total device loss

If the directory can silently replace keys without detection, the system does not achieve meaningful E2EE against a malicious hub.

---

## 5. Message Envelope

All encrypted payloads travel inside a structured envelope. The Hub may inspect and validate the **envelope**; it must not need the plaintext.

```ts
interface EncryptedEnvelope {
  protocolVersion: number;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  recipientDeviceIds?: string[];   // optional; some protocols derive recipients from membership
  messageId: string;
  keyEpoch: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  signature?: Uint8Array;          // when protocol requires explicit sender authentication
}
```

### 5.1 Signature coverage

When a signature is present it must cover a **canonical encoding** of:

- protocol version  
- conversation ID  
- sender user / device  
- recipient scope  
- message ID  
- key epoch  
- nonce  
- ciphertext  

Use a defined canonical serialization (e.g. canonical CBOR). **Do not** sign arbitrary JSON serialization — key order and whitespace differences break verification.

### 5.2 What the Hub may validate

- Schema and required fields
- Size limits
- Authorization (sender is allowed to publish to this conversation / room)
- Basic replay windows at the routing layer (optional, secondary to client-side checks)

The Hub **must not** attempt to decrypt or interpret `ciphertext`.

---

## 6. Encryption and Decryption Flow

### 6.1 Sender (encrypt)

1. Client authenticates to the service and obtains **verified** recipient device key records.
2. Client verifies key-record signatures / trust state and checks device revocation and key epoch.
3. Client establishes or retrieves a **session key** using the chosen reviewed key-agreement protocol.
4. Derive a message AEAD key with **HKDF**, including context:
   - protocol version
   - conversation ID
   - sender and recipient device IDs
   - key epoch
5. Generate a **fresh nonce** as required by the AEAD. Never reuse a nonce with the same key.
6. Encrypt the canonical plaintext. Authenticate relevant routing metadata as associated data (AEAD AAD).
7. Optionally sign the envelope for additional sender authentication.
8. Send the envelope. The Hub validates shape / size / authorization and routes the bytes **without decrypting**.

### 6.2 Recipient (decrypt)

1. Verify signature (if present) and session context.
2. Reject stale or replayed message IDs / counters.
3. Authenticate and decrypt with the AEAD.
4. **Only after successful authentication** advance local replay state / ratchet.
5. Deliver plaintext to the application (Collaboration Engine, chat UI, etc.).

---

## 7. Replay Protection, Forward Secrecy, and Groups

### 7.1 Replay and ordering

- Maintain monotonic per-session message counters (or protocol-defined sequence numbers).
- Persist the highest accepted state safely (IndexedDB / secure storage).
- Reject duplicates and messages older than the accepted window.
- Define a **bounded out-of-order window** to tolerate normal network reordering.
- Message IDs help deduplication but **do not** by themselves prove freshness.

### 7.2 Forward secrecy

Prefer a **ratcheting** (or otherwise forward-secret) session protocol over static long-lived X25519 keys.

On any of the following, advance the conversation **key epoch** and rekey remaining participants:

- Device removal
- Membership change
- Suspected compromise
- Explicit key revocation

Define how offline devices catch up **without** restoring access for revoked members. A removed member must not be able to decrypt future epochs.

### 7.3 Group / multi-device collaboration

Document collaboration often involves multiple devices per user and multiple users per document. This is a **group** problem:

- Group key agreement must be a reviewed design.
- Membership changes must trigger rekey.
- Epoch transitions must be explicit and testable.
- Offline catch-up must not leak future keys to removed members.

Do not treat “encrypt to a list of device public keys with static X25519” as a complete group solution.

---

## 8. Hub Responsibilities and Metadata Leakage

### 8.1 What the Hub is allowed to do

- Authenticate accounts
- Authorize room / conversation membership
- Enforce quotas and rate limits
- Validate envelope schema and size
- Route ciphertext to authorized recipients
- Retain opaque ciphertext if the product explicitly configures retention

### 8.2 What the Hub must not claim

- Content validation of plaintext
- Server-side moderation of message bodies
- Indexing or search over encrypted content (unless a separate, disclosed design exists)

### 8.3 Metadata the Hub can still observe

Even with perfect E2EE of content, the Hub typically sees:

- Participants in a conversation
- Timing of messages
- Approximate sizes
- Routing identifiers (conversation ID, device IDs, etc.)

Document this **metadata leakage** in the security model. Users and compliance teams should not be surprised by it.

---

## 9. Key Storage, Backup, and Recovery

| Rule | Detail |
|------|--------|
| Private keys | Store in platform-protected storage when available (Web Crypto non-extractable keys, Keychain, Keystore, secure enclave) |
| Backups | If supported, encrypt backups with a **user-controlled** recovery secret. Never upload raw private keys |
| Logs & crash reports | Must never contain private keys, shared secrets, plaintext, or recovery material |
| Lost device | Define recovery, device transfer, and revocation behavior explicitly |
| Backup compromise | Document what an attacker who obtains a backup can and cannot do |

On the web, prefer **non-extractable** CryptoKey objects where the browser supports them, and be explicit about the residual risks of XSS and malicious extensions.

---

## 10. Integration with Hub and Collaboration Engine

```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│   Browser    │         │   Core Hub   │         │ Collaboration│
│              │         │              │         │   Engine     │
│ 1. Encrypt   │────────►│ 2. Validate  │────────►│ 3. (optional)│
│    payload   │ cipher  │    envelope  │ cipher  │    store     │
│    locally   │  text   │    + route   │  text   │    opaque    │
│              │         │              │         │    ops       │
│ 4. Decrypt   │◄────────│              │         │              │
│    on receipt│         │              │         │              │
└──────────────┘         └──────────────┘         └──────────────┘
```

**Practical consequences for the Collaboration Engine:**

- Server-side CRDT validation of **plaintext** structure becomes impossible for E2EE documents.
- The server can still enforce authorization, size limits, and envelope schema.
- Snapshots and operation logs, if retained, store **ciphertext**.
- Materialized server-side views (search, export, admin preview) are not available unless a separate non-E2EE path or trusted-compute design is introduced.

Awareness / presence can stay in plaintext (or use a lighter protection) because it is ephemeral and less sensitive; document the choice.

---

## 11. Failure Handling

**Fail closed** on any of the following:

| Condition | Action |
|-----------|--------|
| Invalid signature | Reject message; do not decrypt |
| Unknown or revoked key epoch | Reject; may trigger rekey or user-visible error |
| Revoked device | Reject; update local trust state |
| AEAD authentication failure | Reject; treat as potential tampering |
| Nonce misuse indicators | Reject; log security event |
| Unsupported protocol version | Reject; prompt client upgrade |
| Replay / stale counter | Reject |

Never “best-effort decrypt” or fall back to plaintext on crypto failure.

---

## 12. Testing and Review Requirements

### 12.1 Mandatory test categories

- Known-answer / test-vector tests from the chosen library and protocol
- Tampering (bit flips in ciphertext, nonce, headers)
- Replay and reordered delivery
- Duplicate delivery
- Key-substitution attempts
- Device revocation and epoch transitions
- Offline catch-up after membership change
- Backup / restore paths
- Cross-platform serialization (browser ↔ mobile ↔ desktop)

### 12.2 Before production claims of “E2EE”

- Obtain an **independent cryptographic review** of the protocol choices, key lifecycle, and implementation.
- Document the threat model and metadata leakage honestly.
- Ensure UI and marketing language match the technical reality.

---

## 13. Implementation Guidance for the Web

| Area | Recommendation |
|------|----------------|
| Crypto library | libsodium.js (or equivalent audited WASM/JS binding) or Web Crypto for supported algorithms |
| Key storage | Non-extractable `CryptoKey` where possible; IndexedDB only for encrypted blobs under a user secret |
| Canonical encoding | Define once (e.g. canonical CBOR) and use it for all signatures and HKDF context |
| Worker isolation | Consider performing crypto in a dedicated Worker to reduce XSS impact surface |
| XSS | E2EE does not protect against XSS that can call into the crypto API after the user is logged in — treat XSS as a critical security boundary |
| Service workers | Do not cache plaintext; be careful with any offline queues that hold decrypted content |
| Multi-tab | Coordinate key access and ratchet state carefully across tabs (BroadcastChannel or shared worker) to avoid nonce reuse or divergent ratchets |

---

## 14. Summary

This E2EE design provides **client-side encryption with authenticated public-key distribution**:

- Clients hold the decryption keys; the Hub only routes opaque ciphertext.
- Identity and key authenticity are treated as first-class problems (not “whatever the server sent”).
- A reviewed key-agreement / ratchet protocol is required for forward secrecy.
- Group and multi-device collaboration need an explicit membership-change rekey story.
- The Hub may validate envelopes and enforce authorization, but must not claim content inspection.
- Metadata leakage is acknowledged and documented.
- Private keys stay in platform-protected storage; backups are user-controlled; logs never contain secrets.
- All crypto failures fail closed.
- Independent review is required before production “E2EE” claims.

Together with the **Core Hub** (connections, rooms, routing) and the **Collaboration Engine** (CRDT document state), this layer enables real-time collaborative products that can offer genuine end-to-end protection for sensitive documents — provided the product accepts the corresponding limits on server-side features.

---

*This document is the authoritative architecture reference for End-to-End Encryption in the system. Implementation must follow the cryptographic choices, key lifecycle, envelope format, and fail-closed rules defined here.*