# Rooms and Namespaces — Architecture

**Version:** 1.0  
**Status:** Spec / Implementation Guide  
**Focus:** Web-based real-time Hub (multi-tenant, multi-device)  
**Last updated:** 2026-11-07  

**Related documents:**  
- [Core Hub Architecture](./CORE_HUB_ARCHITECTURE.md)  
- [Presence Management Architecture](./PRESENCE_MANAGEMENT_ARCHITECTURE.md)  
- [Event Management and Delivery](./EVENT_MANAGEMENT_ARCHITECTURE.md)  
- [E2EE Architecture](./E2EE_ARCHITECTURE.md)  
- [Error Handling Architecture](./ERROR_HANDLING_ARCHITECTURE.md)  
- [Middleware Architecture](./MIDDLEWARE_ARCHITECTURE.md)  
- [Implementation Plan](./IMPLEMENTATION_PLAN.md)

---

## Table of Contents

1. [What Namespaces and Rooms Are](#1-what-namespaces-and-rooms-are)
2. [Identity and Storage Model](#2-identity-and-storage-model)
3. [Join Mechanism](#3-join-mechanism)
4. [Publish and Leave](#4-publish-and-leave)
5. [Namespace Isolation](#5-namespace-isolation)
6. [Encryption and Key Lifecycle](#6-encryption-and-key-lifecycle)
7. [Limits and Lifecycle](#7-limits-and-lifecycle)
8. [Integration with Hub, Presence, and Events](#8-integration-with-hub-presence-and-events)
9. [Testing Requirements](#9-testing-requirements)
10. [Implementation Guidance](#10-implementation-guidance)
11. [Summary](#11-summary)

---

## 1. What Namespaces and Rooms Are

| Concept | Role |
|---------|------|
| **Namespace** | Isolation and **policy** boundary for a logical application area or tenant feature (e.g. `chat`, `docs`, `support`) |
| **Room** | Named group of **authorized connections** within a namespace, used for fan-out and shared presence |

A room is a **routing and grouping** primitive. It is **not** an authorization boundary by itself.

Every **join**, **publish**, and **read** must still be authorized against the authenticated principal, tenant, and resource policy. “Being in the room” does not replace `room:join` / `room:publish` checks.

Typical web usage:

- Chat channels → rooms inside a `chat` namespace  
- Collaborative document sessions → rooms (or document subscriptions) inside a `docs` namespace  
- Support tickets / live sessions → rooms inside a tenant-scoped namespace  

---

## 2. Identity and Storage Model

Use **structured identifiers**, not ambiguous string prefixes, as the source of truth.

```ts
interface NamespaceRecord {
  tenantId: string;
  namespaceId: string;
  policyId: string;            // points at rate limits, encryption defaults, etc.
}

interface RoomRecord {
  tenantId: string;
  namespaceId: string;
  roomId: string;
  maxMembers: number;
  encryptionPolicy: 'disabled' | 'optional' | 'required';
}

interface Membership {
  roomKey: string;             // canonical encoding of tenant + namespace + room
  connectionId: string;
  userId: string;
  joinedAt: number;
}
```

### Canonical room key

Derive a single canonical `roomKey` from `(tenantId, namespaceId, roomId)` with an **unambiguous encoding** (length-prefixed fields, or a fixed delimiter scheme that cannot collide).

Broker channel name prefixes may mirror this key for implementation convenience. **A channel prefix is not a security boundary.** Authorization and tenant checks remain mandatory.

---

## 3. Join Mechanism

Join must be safe under concurrency, disconnect races, and encryption policy.

### Steps

1. **Require** an authenticated connection (`Principal` present).
2. **Validate** tenant / namespace / room identifiers and that the room exists (or may be auto-created under policy).
3. **Authorize** `room:join` for the principal (middleware / AuthZ).
4. **Enforce capacity atomically** and **reserve** a member slot before side effects.
5. **Encryption gate (if policy is `required`)**  
   Verify the client has a valid **current-epoch** key registration before admitting them.  
   Reject unkeyed members. Do **not** silently skip them during later encrypted broadcast.
6. **Commit membership idempotently** using `(roomKey, connectionId)` as the unique key.
7. **Publish** join / presence events only after commit.
8. On **any failure or disconnect race**, release the reservation and roll back partial state.

### Race rules

- Use a per-room mutex / actor **or** an atomic store operation for capacity + membership.
- After every `await`, recheck that the connection is still authenticated.
- A disconnect while join is in flight must cancel or fully roll back — no half-joined members.

---

## 4. Publish and Leave

### Publish

1. Authorize `room:publish` (or the specific event permission).
2. Resolve the **current** membership set (snapshot).
3. Enforce room message-size, rate, and encryption policy.
4. If encryption is `required`:
   - Reject plaintext.
   - Require a valid ciphertext envelope for the **current key epoch**.
5. Hand off to the [Event Management](./EVENT_MANAGEMENT_ARCHITECTURE.md) layer for fan-out and optional delivery tracking.

### Leave / disconnect

1. Remove membership **once** (idempotent).
2. Clear room-scoped ephemeral state (typing, cursors, room-local presence bits).
3. Update presence aggregates.
4. Notify remaining members according to privacy policy.
5. Release capacity.

Leave and Hub disconnect cleanup must both be safe if called more than once.

---

## 5. Namespace Isolation

Namespaces may share one Hub process, but isolation is **logical and enforced**, not implied by naming.

### Always enforce per tenant / namespace

| Surface | Isolation requirement |
|---------|------------------------|
| Storage keys | Tenant-aware |
| Authorization | Tenant + namespace + room |
| Quotas | Per tenant / namespace where configured |
| Event routing | Never cross tenant |
| Presence visibility | Scoped by room / policy |
| Document permissions | Independent of room membership |

### Stronger operational isolation (optional)

If a product runs **separate Hub instances** per tenant or high-value namespace, define independently:

- Auth configuration  
- Storage partitions  
- Broker topics  
- Quotas  
- Observability labels  

Still do **not** treat a broker channel prefix alone as equivalent to a separate security boundary.

---

## 6. Encryption and Key Lifecycle

Align with the [E2EE Architecture](./E2EE_ARCHITECTURE.md). Rooms carry an `encryptionPolicy`:

| Policy | Behavior |
|--------|----------|
| `disabled` | Plaintext allowed; no key checks on join |
| `optional` | Define whether mixed encrypted/plaintext is allowed; document per-message rules |
| `required` | Membership blocked until key enrollment for the **current epoch** succeeds |

### Required-encryption rules

- Unkeyed clients are **rejected** at join (or blocked from publish until enrolled).
- On device removal or key revocation: **advance room key epoch** and rekey remaining members before future sends.
- Define how offline members obtain the new epoch and how **stale epochs are rejected**.
- In a **server-blind E2EE** design, the Hub **routes ciphertext only**; it does not derive group plaintext keys.

Never admit a member into a `required` room and then “skip” them on encrypted broadcast — that creates silent message loss and false security assumptions.

---

## 7. Limits and Lifecycle

### Recommended baseline defaults (tune per product)

Set explicit caps for:

- Maximum rooms per connection  
- Members per room  
- Namespaces per tenant  
- Room metadata size (bytes)  
- Join attempts / rate  
- Fan-out concurrency per publish  

Expose limit violations as typed errors (`ROOM_FULL`, `RATE_LIMITED`, `VALIDATION_FAILED`, etc.) via the [Error Handling](./ERROR_HANDLING_ARCHITECTURE.md) registry.

### Room deletion

When a room is deleted:

1. Reject new joins.  
2. Drain or fail pending sends.  
3. Remove all memberships.  
4. Clear ephemeral presence and awareness for that room.  
5. Retain durable history **only** according to an explicit retention policy (often none for pure ephemeral rooms; separate for chat history products).

---

## 8. Integration with Hub, Presence, and Events

```
Authenticate (Hub)
    → joinRoom (authorize + capacity + optional key check)
        → membership commit
        → presence update
        → event: member_joined (policy permitting)

publish to room
    → authorize + encryption policy
    → resolve membership snapshot
    → Event subsystem fan-out

leave / disconnect
    → membership remove
    → clear room-scoped awareness
    → presence update
    → event: member_left (policy permitting)
```

- **Hub** owns connection identity and the join/leave API surface.  
- **Rooms/Namespaces** own membership, capacity, and policy.  
- **Presence** projects online state from membership + leases.  
- **Events** deliver messages to the membership set.  
- **E2EE** (when enabled) constrains join and publish payloads; Hub still does not read plaintext in server-blind mode.

---

## 9. Testing Requirements

| Scenario | Assert |
|----------|--------|
| Cross-tenant isolation | Tenant A cannot join or see tenant B rooms |
| Unauthorized join / publish | Rejected with correct error codes |
| Capacity races | Concurrent joins never exceed `maxMembers` |
| Duplicate join / leave | Idempotent; membership count stable |
| Disconnect during join | No half-joined membership; reservation released |
| Required encryption, no key | Join or publish rejected |
| Stale key epoch | Rejected; client must rekey |
| Revocation / rekey | New epoch required; old epoch cannot send |
| Namespace / room deletion | Joins fail; memberships cleared; ephemeral state gone |
| Multi-instance membership | Consistent view after failover / broker recovery |

Also test: broker prefix collisions do not bypass auth; canonical `roomKey` encoding is stable.

---

## 10. Implementation Guidance

1. Store membership under the canonical `roomKey`, not under raw client-supplied strings alone.  
2. Keep capacity reservation and membership commit in one atomic section (or a single-threaded room actor).  
3. Snapshot membership for publish; do not hold the room lock while writing to the network.  
4. Align room encryption policy with the global E2EE threat model — do not invent a second crypto story.  
5. Clear room-scoped typing/cursors on leave via the Presence / awareness path.  
6. Metric ideas: joins, leaves, active rooms, members per room, join failures by reason, encryption rejections, fan-out size.  
7. Feature-flag new namespace types and encryption modes during rollout ([Implementation Plan](./IMPLEMENTATION_PLAN.md)).

---

## 11. Summary

**Namespaces** provide policy and isolation boundaries. **Rooms** provide named, capacity-limited groups of authorized connections for fan-out and shared presence.

- Membership is authorized on every join and publish; the room is not itself the ACL.  
- Capacity is reserved atomically; joins are idempotent and race-safe.  
- Encryption policy (`disabled` / `optional` / `required`) gates membership and payloads; required mode demands current-epoch keys.  
- Tenant isolation is enforced in keys, AuthZ, routing, and visibility — not by channel name prefixes.  
- Leave and deletion clean membership, ephemeral state, and presence consistently.

Together with the Core Hub, Presence, Events, and optional E2EE, rooms and namespaces form the multiplayer grouping layer for web real-time products.

---

*This document is the authoritative architecture reference for Rooms and Namespaces. Identifier encoding, join/publish rules, isolation, and encryption policy behavior defined here must be followed by Hub implementations.*