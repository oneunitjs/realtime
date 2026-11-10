# Presence Management — Architecture

**Version:** 1.0  
**Status:** Spec / Implementation Guide  
**Focus:** Web-based real-time systems (multi-device, multi-tab, rooms)  
**Last updated:** 2026-11-07  

**Related documents:**  
- [Core Hub Architecture](./CORE_HUB_ARCHITECTURE.md)  
- [Event Management and Delivery](./EVENT_MANAGEMENT_ARCHITECTURE.md)  
- [Error Handling Architecture](./ERROR_HANDLING_ARCHITECTURE.md)  
- [Collaboration Engine Architecture](./COLLABORATION_ENGINE_ARCHITECTURE.md)  
- [Middleware Architecture](./MIDDLEWARE_ARCHITECTURE.md)  
- [Implementation Plan](./IMPLEMENTATION_PLAN.md)

---

## Table of Contents

1. [What Presence Is](#1-what-presence-is)
2. [Data Model](#2-data-model)
3. [Update Mechanism](#3-update-mechanism)
4. [API Behavior](#4-api-behavior)
5. [Typing and Collaboration Awareness](#5-typing-and-collaboration-awareness)
6. [Concurrency and Authorization](#6-concurrency-and-authorization)
7. [Multi-Instance Considerations](#7-multi-instance-considerations)
8. [Integration with Hub and Events](#8-integration-with-hub-and-events)
9. [Testing Requirements](#9-testing-requirements)
10. [Implementation Guidance](#10-implementation-guidance)
11. [Summary](#11-summary)

---

## 1. What Presence Is

**Presence** is an **ephemeral** view of:

- Which users and devices are currently connected
- What transient activity they report (status, typing, cursors)

It is a **projection derived from live connections and leases**, not a durable account record. When the last connection for a user goes away and leases expire, presence goes away with it.

### Critical distinction

| Concept | Meaning |
|---------|---------|
| **Device presence** | State of one browser tab / mobile app / desktop client (one connection or device) |
| **User presence** | Aggregate computed from all of that user’s devices |

A user can be **online** on phone and **away** on laptop at the same time. Disconnecting one device must **not** mark the whole user offline if another device is still live.

Presence is **not**:

- The source of truth for account profile data
- Part of the CRDT document log
- A durable “last seen” history store (unless the product explicitly adds a separate durable feature)

---

## 2. Data Model

```ts
type DeviceStatus = 'online' | 'away' | 'busy' | 'offline';

interface DevicePresence {
  deviceId: string;
  connectionId?: string;       // live Hub connection, if any
  status: DeviceStatus;
  lastSeenAt: number;
  expiresAt: number;           // lease expiry
  customStatus?: string;       // optional short text
}

interface UserPresence {
  userId: string;
  status: DeviceStatus;        // aggregate
  devices: DevicePresence[];
  updatedAt: number;
}
```

### Identity rules

- `userId` comes from the **authenticated principal** only.
- A client **cannot** set another user’s presence.
- `deviceId` is bound to the authenticated session / device registration policy of the product.

### Aggregate status precedence

The aggregate `UserPresence.status` must be computed with an **explicit, deterministic** rule. Example:

```text
if any device is online  → online
else if any device is busy → busy
else if any device is away → away
else → offline
```

Product teams may choose a different order (e.g. treating `busy` as higher priority than `online`), but the rule must be documented and stable so all instances and clients agree.

---

## 3. Update Mechanism

### 3.1 Lifecycle steps

1. **Authenticated connect**  
   Create or refresh the device lease; set status (usually `online`); set `lastSeenAt` and `expiresAt`.

2. **Heartbeat / activity**  
   Update `lastSeenAt` and extend `expiresAt`. Do not necessarily publish a presence event on every heartbeat—only when the visible state changes or a refresh is required.

3. **Explicit status change**  
   Validate allowed status values and `customStatus` length/content. Recompute aggregate. Publish only if the user-visible projection changed.

4. **Disconnect**  
   Mark **that connection’s** device lease offline or remove it.  
   **Do not** mark the whole user offline if another device remains online.

5. **Periodic expiry worker**  
   Remove stale leases (past `expiresAt` + grace). Recompute aggregates for affected users. Publish meaningful changes.

### 3.2 Lease model

Each device presence entry is a **lease**:

- Extended by heartbeats and authenticated activity
- Expires if the client goes silent (closed tab, crashed process, bad network)
- Grace period absorbs clock skew and transient network delay

Recommended defaults (configurable):

| Parameter | Typical range |
|-----------|----------------|
| Heartbeat interval (client) | 20–30 s |
| Lease TTL | 60–90 s |
| Expiry grace | 10–30 s |

Align these with the Core Hub heartbeat policy so connection expiry and presence expiry do not fight each other.

---

## 4. API Behavior

| API | Returns | Notes |
|-----|---------|--------|
| `getUser(userId)` | `UserPresence` | Aggregate + device list (filtered by caller’s visibility rights) |
| `getDevice(deviceId)` | `DevicePresence` | Single device record |
| `getRoom(roomId)` | Authorized projection of members’ presence | **Must** enforce room visibility / membership |

### Policy choices to document

- Are **offline** users returned as explicit `{ status: 'offline' }` records, or **omitted** from lists?
- How much device detail is visible to other users (device count only vs full device list)?
- Are `customStatus` strings visible outside the tenant / room?

Room presence queries must never return users the caller is not allowed to see.

---

## 5. Typing and Collaboration Awareness

Typing indicators, cursors, and selections are **not** durable presence fields and **not** CRDT document operations.

| Signal | Characteristics |
|--------|-----------------|
| Typing | Very short TTL; rate-limited; cleared on stop / disconnect / room leave |
| Cursor / selection | High frequency; coalesce updates; drop under backpressure |
| Active document | Optional; cleared on document switch or disconnect |

**Clear these signals when:**

- Connection disconnects
- User leaves the room
- User switches document
- TTL expires

They travel on the **ephemeral event path** (see [Event Management](./EVENT_MANAGEMENT_ARCHITECTURE.md)), typically with `delivery: 'ephemeral'`. They must not be written to the Collaboration Engine operation log.

Under load, prefer **coalescing** (keep latest cursor position) over queuing every intermediate update.

---

## 6. Concurrency and Authorization

### 6.1 Concurrent updates

Serialize updates **per user** or **per device**, or use atomic compare-and-set with a version number, so concurrent `customStatus` changes do not overwrite each other unpredictably.

### 6.2 Who can see what

Authorize presence reads by:

- Tenant boundary
- Room membership
- Optional privacy settings (e.g. “appear offline”)

### 6.3 What never appears in presence payloads

- IP addresses
- Session tokens
- Private device metadata (OS details, exact user agent strings, etc.) beyond what the product has explicitly approved

Presence is highly visible; treat it as a privacy-sensitive surface.

---

## 7. Multi-Instance Considerations

When multiple Hub instances run behind a broker:

| Concern | Approach |
|---------|----------|
| Lease storage | Shared store with TTL **or** lease updates published through the broker |
| Reconciliation | After broker recovery or instance restart, rebuild presence from live connections + remaining leases |
| Clock skew | Prefer a monotonic / authoritative time source for expiry; keep a grace window |
| Split view | Avoid long windows where instance A thinks a user is online and instance B thinks they are offline; reconciliation and short TTLs limit the gap |

Presence is allowed to be **briefly** inconsistent under partition; it must **self-heal** when connectivity returns. It must not leave permanent “ghost” online users.

---

## 8. Integration with Hub and Events

```
Connect (Hub)     → create/refresh device lease → maybe publish user aggregate change
Heartbeat (Hub)   → extend lease
Disconnect (Hub)  → drop that device lease → recompute user aggregate → publish if changed
Status API        → validate → update device → recompute → publish if changed
Expiry worker     → remove stale leases → recompute → publish if changed
Typing / cursor   → ephemeral events, separate TTL, not stored as durable presence
```

- **Hub** owns connection lifecycle and heartbeats.  
- **Presence service** owns leases, aggregates, and projections.  
- **Event subsystem** fans out presence and awareness updates to authorized subscribers (often room-scoped).  
- **Collaboration Engine** does not store presence or cursors in the CRDT log.

Errors (unauthorized read, invalid status, rate limit on typing) map through the shared [Error Handling](./ERROR_HANDLING_ARCHITECTURE.md) registry.

---

## 9. Testing Requirements

| Scenario | Assert |
|----------|--------|
| Multi-device aggregation | Correct aggregate when devices have different statuses |
| One device disconnects, another stays | User remains online / correct aggregate |
| Lease expiry | Device drops after TTL + grace; aggregate updates |
| Reconnect | Lease restored; no duplicate ghost devices |
| Broker partition / reconciliation | Presence converges after recovery; no permanent ghosts |
| Concurrent status updates | No lost updates; deterministic final state |
| Room visibility | Caller only sees members they are allowed to see |
| Typing / cursor cleanup | Cleared on disconnect, leave, document switch, expiry |
| Clock skew | Grace prevents premature expiry under small skew |
| Privacy | No IP / tokens / forbidden metadata in payloads |

Also verify: expiry worker does not leak timers or unbounded memory under large user counts.

---

## 10. Implementation Guidance

1. Treat presence as a **cache of leases**, not a primary user database.  
2. Publish **deltas** (or “meaningful changes” only) to avoid flooding clients on every heartbeat.  
3. Keep typing/cursor on a **separate, highly rate-limited** path from status presence.  
4. Align lease TTL with Hub heartbeat timeouts.  
5. For multi-instance, pick one approach (shared TTL store vs brokered lease events) and test reconciliation explicitly.  
6. Document aggregate precedence and offline-omit-vs-explicit policy for product and client teams.  
7. Metric suggestions: online users, devices per user, expiry rate, presence publish rate, typing event rate, reconciliation runs.

---

## 11. Summary

Presence Management provides an **ephemeral, lease-based projection** of who is connected and what they are doing:

- **Device** state is tracked per connection/device with TTL.  
- **User** state is a deterministic aggregate of devices.  
- Disconnect of one device does not offline the whole user.  
- Typing, cursors, and selections are short-lived awareness signals—not CRDT data and not durable presence fields.  
- Authorization and privacy rules apply to every read.  
- Multi-instance deployments rely on shared leases or brokered updates plus reconciliation; presence self-heals after partitions.

Together with the Core Hub (connections and heartbeats) and the Event subsystem (fan-out), this layer gives web clients accurate-enough “who is here” and “who is typing” without polluting durable collaboration state.

---

*This document is the authoritative architecture reference for Presence Management. Lease semantics, aggregate rules, awareness separation, and privacy constraints defined here must be followed by Hub and client implementations.*