# Event Management and Delivery — Architecture

**Version:** 1.0  
**Status:** Spec / Implementation Guide  
**Focus:** Web-based real-time systems (Hub, rooms, multi-device clients)  
**Last updated:** 2026-11-06  
**Related:**  
- [Core Hub Architecture](./CORE_HUB_ARCHITECTURE.md)  
- [Error Handling Architecture](./ERROR_HANDLING_ARCHITECTURE.md)  
- [Collaboration Engine Architecture](./COLLABORATION_ENGINE_ARCHITECTURE.md)  
- [E2EE Architecture](./E2EE_ARCHITECTURE.md)

---

## Table of Contents

1. [What This Subsystem Is](#1-what-this-subsystem-is)
2. [Delivery Guarantees (Be Precise)](#2-delivery-guarantees-be-precise)
3. [Event Envelope](#3-event-envelope)
4. [Delivery States and Records](#4-delivery-states-and-records)
5. [ACK and Retry Mechanism](#5-ack-and-retry-mechanism)
6. [Broadcast and Routing](#6-broadcast-and-routing)
7. [Public API](#7-public-api)
8. [Failure Behavior](#8-failure-behavior)
9. [Multi-Device Semantics](#9-multi-device-semantics)
10. [Integration with Hub and Collaboration](#10-integration-with-hub-and-collaboration)
11. [Testing Requirements](#11-testing-requirements)
12. [Implementation Guidance](#12-implementation-guidance)
13. [Summary](#13-summary)

---

## 1. What This Subsystem Is

The **event subsystem** validates, routes, and optionally tracks application messages between clients, rooms, and namespaces.

It is the layer that answers:

- Who is allowed to send this event?
- Who should receive it?
- Did the server accept it?
- Did the transport write it to a given connection?
- Did the recipient’s client acknowledge receipt?
- Did the recipient’s application finish processing it?

These are **different guarantees**. Confusing them leads to incorrect product claims (“we have reliable delivery”) and hard-to-debug production issues.

**Typical event types in a web collaboration product**

| Kind | Examples | Usual delivery mode |
|------|----------|---------------------|
| Ephemeral presence | Cursor move, typing indicator | `ephemeral` |
| Room chat / signals | “User joined”, custom app events | `ephemeral` or `at-least-once` |
| Collaboration ops | CRDT operations (when not on a dedicated path) | Often dedicated Collaboration Engine path; if via events → `at-least-once` |
| Notifications | Mentions, share invites | `at-least-once` with durable mailbox optional |

---

## 2. Delivery Guarantees (Be Precise)

| Term | Meaning in this system |
|------|------------------------|
| **Server accepted** | Hub validated schema, auth, size, and queued/routed the event |
| **Transport written** | Bytes were accepted by the local transport for a specific connection |
| **Recipient received** | Recipient connection sent a delivery ACK (`received`) |
| **Application processed** | Recipient application sent a processing ACK (`processed`) |
| **Ephemeral** | Best-effort; may be dropped under backpressure; no retry |
| **At-least-once** | Retried until ACK, expiry, or retry budget; duplicates possible |
| **Exactly-once** | **Not claimed.** Achieve effective exactly-once only with at-least-once + idempotent consumers |

Never call an event “acknowledged” without stating **which** ACK level you mean.

---

## 3. Event Envelope

Every routed message is wrapped in a structured envelope:

```ts
interface EventEnvelope<T = unknown> {
  protocolVersion: number;
  messageId: string;              // stable across retries
  event: string;                  // event name / type
  senderConnectionId: string;
  senderUserId: string;
  namespace: string;
  roomId?: string;
  createdAt: number;
  expiresAt?: number;
  delivery: 'ephemeral' | 'at-least-once';
  payload: T;
}
```

### 3.1 Validation before routing

The Hub (or event middleware) **must** validate:

| Check | Why |
|-------|-----|
| Schema / required fields | Protocol integrity |
| Payload size | Memory and DoS protection |
| Tenant / namespace scope | Multi-tenant isolation |
| Sender identity | Derived from the **authenticated connection**, never from payload fields |
| Authorization | e.g. `room:message`, `document:write`, custom event ACLs |
| `delivery` mode allowed for this event type | Policy |

**Critical rule:** `senderUserId` and `senderConnectionId` are taken from the authenticated `ClientConnection` / `Principal`. Values inside the payload are ignored for identity and authorization.

### 3.2 Stable `messageId`

- Generated once when the event is first accepted.
- **Reused** on every retry of the same logical event.
- Clients and servers deduplicate by `messageId`.
- Idempotency keys supplied by the publisher may be used to derive or look up the same `messageId` on duplicate publish attempts.

---

## 4. Delivery States and Records

### 4.1 State machine (per recipient)

```
created → accepted → queued → written → received → processed
                         ↘       ↘         ↘
                       failed   failed    failed
                         ↘
                       expired
```

| State | Meaning |
|-------|---------|
| `created` | Envelope constructed |
| `accepted` | Passed validation and authorization |
| `queued` | Waiting for fan-out / write to a specific connection |
| `written` | Local transport accepted the bytes for that connection |
| `received` | Recipient sent a delivery ACK |
| `processed` | Recipient application sent a processing ACK |
| `failed` | Retry budget exhausted or hard error |
| `expired` | Past `expiresAt` or mailbox TTL |

`written` ≠ `received`. A resolved WebSocket `send` only means the local stack accepted the data; the browser may still be gone.

### 4.2 Delivery record

When receipt tracking is enabled, one record exists **per recipient connection** (or per device, depending on policy):

```ts
interface DeliveryRecord {
  messageId: string;
  recipientConnectionId: string;
  state: 'queued' | 'written' | 'received' | 'processed' | 'failed' | 'expired';
  attempts: number;
  deadlineAt: number;
}
```

For multi-device users, define explicitly whether the sender waits for:

- **Any** device,
- **All** devices, or
- A **quorum**.

Document the chosen policy per event type.

---

## 5. ACK and Retry Mechanism

### 5.1 ACK shape

```ts
interface DeliveryAck {
  messageId: string;
  recipientConnectionId: string;
  kind: 'received' | 'processed';
}
```

- Authenticate the ACK against the **actual** connection that sends it.
- ACKs are **idempotent**: repeating the same ACK does not change the outcome.
- A late ACK that arrives after a retry still completes the **same** delivery record (same `messageId` + recipient).

### 5.2 Retry rules

| Condition | Behavior |
|-----------|----------|
| `delivery: 'ephemeral'` | No retry. May drop under backpressure. |
| `delivery: 'at-least-once'` | Retry with the **same** `messageId`, bounded exponential backoff + jitter |
| Retry budget exhausted | Mark `failed`, emit typed delivery failure (`DELIVERY_FAILED` / `RETRY_EXHAUSTED`) |
| Event past `expiresAt` | Mark `expired` |

Separate timeout budgets for:

1. Application response (publisher waiting on Hub)
2. Delivery receipt (`received`)
3. Processing completion (`processed`)

A transport write resolving does **not** start the “processed” timer by itself.

### 5.3 Reconnect and replay

On recipient reconnect:

- Replay only if the event is durable **and** the recipient policy allows it.
- Consumer **must** deduplicate by `messageId`.
- Do not replay ephemeral events.

---

## 6. Broadcast and Routing

### 6.1 Recipient resolution

1. Take an **authorized** snapshot of room / namespace members (or document subscribers).
2. Apply explicit options (e.g. `excludeSender: true`).
3. Create one delivery record per target connection when tracking is enabled.
4. Fan out with **bounded concurrency** and **per-client queue limits**.

### 6.2 Concurrency and locking

- Resolve the member list under a short critical section if needed.
- **Do not** hold room locks while performing network I/O.
- For large rooms, batch sends and respect backpressure signals from the transport.

### 6.3 Partial success

Publish results must represent partial success honestly:

```ts
interface PublishResult {
  messageId: string;
  accepted: number;   // recipients for which delivery was accepted/queued
  failed: number;     // hard failures
  pending: number;    // still in flight (at-least-once)
}
```

Never collapse a partial fan-out into a single boolean “success.”

---

## 7. Public API

```ts
interface PublishOptions {
  delivery?: 'ephemeral' | 'at-least-once';
  timeoutMs?: number;
  idempotencyKey?: string;
  excludeSender?: boolean;
  // optional: waitFor: 'none' | 'received' | 'processed'
}

interface PublishResult {
  messageId: string;
  accepted: number;
  failed: number;
  pending: number;
}

// Hub / event service
publish(
  connectionId: string,
  event: string,
  payload: unknown,
  options?: PublishOptions
): Promise<PublishResult>;
```

### 7.1 ACK API consistency

Expose **one** clear way for the recipient application to ACK:

- Either via event context: `context.ack('received' | 'processed')`
- Or via client SDK: `engine.ack(messageId, kind)`

Do **not** ship both `envelope.ack()` and `context.ack()` with undocumented differences. Document the single supported path.

---

## 8. Failure Behavior

| Situation | Expected behavior |
|-----------|-------------------|
| Ephemeral + backpressure | Drop; no retry; metrics incremented |
| Reliable + overload | Bounded queue; when full, reject with typed error (`OVERLOADED` / `RATE_LIMITED`) |
| Recipient disconnect (ephemeral) | Delivery ends; no mailbox |
| Recipient disconnect (at-least-once) | Either retain in a **durable mailbox** with expiry, or mark `failed` — document which mode the product uses |
| Retry budget exhausted | `failed` + typed error to publisher / monitoring |
| Duplicate publish (same idempotency key) | Return the original `messageId` / result; do not create a second logical event |
| ACK from wrong connection | Reject; security / protocol telemetry |
| Process restart | Durable at-least-once events survive according to persistence policy; ephemeral do not |

**Exactly-once is not provided.** Design consumers to be idempotent on `messageId`.

---

## 9. Multi-Device Semantics

A single user may have multiple browser tabs or devices, each with its own `connectionId`.

Define per event type (or globally):

| Policy | Meaning |
|--------|---------|
| **Any device** | Success when at least one connection ACKs |
| **All devices** | Success only when every currently registered device ACKs (or times out) |
| **Quorum** | Success when N of M devices ACK |
| **Connection-scoped only** | Track only the connections that were members at publish time; new devices do not retroactively require delivery |

Presence and cursor events are almost always connection-scoped and ephemeral. Important notifications may use durable mailbox + multi-device fan-out.

---

## 10. Integration with Hub and Collaboration

```
Client A                    Core Hub                     Client B
   │                           │                            │
   │  publish(event, payload)  │                            │
   │──────────────────────────►│ validate + authorize       │
   │                           │ resolve recipients         │
   │                           │ create delivery records    │
   │                           │───────────────────────────►│  envelope
   │                           │                            │
   │                           │◄───────────────────────────│  ACK received
   │                           │ (optional)                 │
   │                           │◄───────────────────────────│  ACK processed
   │  PublishResult            │                            │
   │◄──────────────────────────│                            │
```

**Collaboration Engine ops** may travel on a dedicated path (see Collaboration Engine architecture) rather than the generic event bus. When they do use the event subsystem, they must use `at-least-once` and stable operation IDs that align with CRDT `opId`s.

**E2EE:** For encrypted events the `payload` is ciphertext (or an `EncryptedEnvelope`). The event subsystem still validates the outer envelope and routes bytes; it does not decrypt.

**Error model:** All failures map through the shared [Error Handling](./ERROR_HANDLING_ARCHITECTURE.md) registry (`VALIDATION_FAILED`, `FORBIDDEN`, `ROOM_NOT_FOUND`, `DELIVERY_FAILED`, `RETRY_EXHAUSTED`, `OVERLOADED`, etc.).

---

## 11. Testing Requirements

| Scenario | Assert |
|----------|--------|
| Duplicate publish (same idempotency key) | Single logical `messageId`; stable result |
| Duplicate ACK | Idempotent; state does not regress |
| Late ACK after retry | Completes the same delivery record |
| ACK from wrong connection | Rejected; no state change for the real recipient |
| Retry exhaustion | `failed`; typed error; no infinite loop |
| Recipient disconnect (both delivery modes) | Documented behavior; no leaked records |
| Reconnect replay | Only durable events; consumer dedupe works |
| Multi-device policies | Any / all / quorum behave as specified |
| Partial broadcast failure | `PublishResult` shows accepted / failed / pending correctly |
| Expiry | Records move to `expired`; no further retries |
| Backpressure | Ephemeral dropped; reliable rejected or queued per policy |
| Process restart | Durable events recover; ephemeral do not |
| Stable IDs | `messageId` unchanged across retries |

Also verify: no leaked delivery records, timers, or per-connection queues after cleanup.

---

## 12. Implementation Guidance

1. **Generate `messageId` once** at acceptance; never regenerate on retry.
2. **Derive sender identity** only from the authenticated connection.
3. **Separate** transport write success from recipient ACK.
4. Use **bounded** queues and concurrency for fan-out; surface backpressure.
5. Hold room membership locks only for snapshotting members, not for network I/O.
6. Persist delivery records for `at-least-once` according to an explicit retention/expiry policy.
7. Make consumer handlers **idempotent** on `messageId` by default in SDK docs and examples.
8. Emit metrics: published, written, received, processed, failed, expired, dropped (ephemeral), retry counts, fan-out size.
9. Align error codes with the central Error Handling registry.
10. Document multi-device and mailbox policy in product-facing terms so support and clients know what to expect.

---

## 13. Summary

The event subsystem provides **validated, authorized routing** of application messages with explicit, layered delivery semantics:

- **Ephemeral** — best-effort, droppable, no retry  
- **At-least-once** — retried with stable `messageId`, bounded budget, optional durable mailbox  

It tracks delivery **per recipient connection**, distinguishes `written` vs `received` vs `processed`, and never claims exactly-once delivery. Partial fan-out results are visible. Multi-device behavior is defined deliberately. Sender identity always comes from the authenticated connection.

Together with the Core Hub (connections and rooms), Error Handling (typed failures and retries), and the Collaboration Engine (document state), this layer enables reliable real-time application messaging on the web without over-promising delivery guarantees.

---

*This document is the authoritative architecture reference for Event Management and Delivery. Implementation must conform to the envelope format, state machine, ACK/retry rules, and failure behaviors defined here.*