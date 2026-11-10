# Collaboration Engine — Architecture

**Version:** 1.1  
**Status:** Spec / Implementation Guide  
**Focus:** Web-based real-time collaborative documents  
**Last updated:** 2026-11-06

---

## Table of Contents

1. [Why This Exists](#1-why-this-exists)
2. [What the Engine Does (and Does Not Do)](#2-what-the-engine-does-and-does-not-do)
3. [Web Collaboration Architecture](#3-web-collaboration-architecture)
4. [Core Concepts Explained Simply](#4-core-concepts-explained-simply)
5. [Data Model](#5-data-model)
6. [How Text Collaboration Works (RGA)](#6-how-text-collaboration-works-rga)
7. [How Metadata Fields Work (LWW Maps)](#7-how-metadata-fields-work-lww-maps)
8. [Identity, Operations, and Causality](#8-identity-operations-and-causality)
9. [Sync Protocol for the Web](#9-sync-protocol-for-the-web)
10. [Client SDK (Browser / Web App)](#10-client-sdk-browser--web-app)
11. [Server Responsibilities](#11-server-responsibilities)
12. [Persistence, Snapshots, and Compaction](#12-persistence-snapshots-and-compaction)
13. [Awareness, Cursors, and Presence](#13-awareness-cursors-and-presence)
14. [Authorization and Security](#14-authorization-and-security)
15. [Failure Handling](#15-failure-handling)
16. [Implementation Roadmap](#16-implementation-roadmap)
17. [Required Invariants and Testing](#17-required-invariants-and-testing)
18. [Observability](#18-observability)
19. [Versioning and Evolution](#19-versioning-and-evolution)
20. [Summary](#20-summary)

---

## 1. Why This Exists

Modern web apps (docs, notes, whiteboards, project tools, code editors) need multiple people editing the same document at the same time. Users expect:

- Instant local feedback (typing feels native)
- Other people’s changes appearing in near real-time
- Correct merging when two people edit the same place offline or with lag
- The document still making sense after a network blip or browser refresh

Traditional approaches fall short:

| Approach | Problem for web collab |
|----------|------------------------|
| Last-write-wins on the whole document | One user overwrites the other |
| Operational Transformation (OT) | Complex, hard to get right, often needs a central transformer |
| “Just use WebSockets and hope” | Race conditions, lost updates, inconsistent state |
| Off-the-shelf CRDT libraries (Yjs, Automerge) | Powerful, but you inherit their model, versioning, and sometimes licensing / size |

This project builds a **custom, deliberately constrained CRDT** so the team owns the algorithm, the wire format, the ordering rules, and the migration story. It is optimized for **browser clients + a durable server**, not for fully peer-to-peer offline-first scenarios (though offline support is included).

---

## 2. What the Engine Does (and Does Not Do)

### 2.1 What It Does

The Collaboration Engine keeps multiple browser tabs / devices in sync on a shared document by:

1. Letting each client create **operations** (insert character, delete character, set a field).
2. Giving every operation a unique, stable ID tied to the device that created it.
3. Recording **causal dependencies** so operations are applied only when their prerequisites exist.
4. Using deterministic merge rules so every client that has seen the same set of operations ends up with the **identical document state**, regardless of network order or duplicates.
5. Persisting operations on the server so a refreshed or reconnected browser can catch up.

### 2.2 What It Does *Not* Do by Itself

| Concern | Handled by |
|---------|------------|
| Who is allowed to read/write | Auth + ACL layer |
| Storing the document forever | Persistence / database |
| Showing cursors and “User X is typing” | Separate ephemeral awareness channel |
| Rich text (bold, links, embeds, nested blocks) | Future extension — not in v1 |
| End-to-end encryption that hides structure from the server | Optional product decision with trade-offs |

CRDT convergence ≠ product correctness. You still need validation, permissions, and a clear data model.

### 2.3 Supported Use Cases (v1)

| Feature | Supported | Notes |
|---------|-----------|-------|
| Plain-text collaborative editing | Yes | Character / token level via RGA |
| Document metadata (title, status, tags…) | Yes | Last-writer-wins map fields |
| Collaborative counters (votes, reactions) | Optional | PN-Counter only — never LWW numbers |
| Cursors, selection, typing indicators | Yes | Ephemeral, not in the CRDT log |
| Offline editing + reconnect | Yes | Local pending ops + vector-clock sync |
| Rich text / block editors | Not yet | Requires explicit CRDT design + migrations |
| Arbitrary nested JSON | Not yet | Same reason |

**Primary product goal:** Multiple authenticated web clients can edit the same document (online or offline) and eventually see identical content once they have exchanged the same operations.

---

## 3. Web Collaboration Architecture

```
┌──────────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│  Browser Tab A       │   │  Browser Tab B       │   │  Mobile / Desktop    │
│                      │   │                      │   │                      │
│  CollaborationEngine │   │  CollaborationEngine │   │  CollaborationEngine │
│  • Local RGA + Map   │   │  • Local RGA + Map   │   │  • Local RGA + Map   │
│  • Actor + counter   │   │  • Actor + counter   │   │  • Actor + counter   │
│  • Pending ops queue │   │  • Pending ops queue │   │  • Pending ops queue │
│  • IndexedDB cache   │   │  • IndexedDB cache   │   │  • Local storage     │
└──────────┬───────────┘   └──────────┬───────────┘   └──────────┬───────────┘
           │                          │                          │
           │         WebSocket        │                          │
           │      (auth token)        │                          │
           └──────────────────────────┼──────────────────────────┘
                                      │
                         ┌────────────▼────────────┐
                         │   Collaboration Server  │
                         │                         │
                         │  Auth & document ACL    │
                         │  Operation validation   │
                         │  Durable operation log  │
                         │  Periodic snapshots     │
                         │  Multi-instance fan-out │
                         │  Materialized view      │
                         └─────────────────────────┘
```

### Design principles for the web

1. **Optimistic UI** — The local client applies its own operations immediately so typing feels instant. Remote operations arrive later and are merged.
2. **Server is authoritative for durability and identity**, but **not** for the final merge order. Convergence is defined by the CRDT rules, not by “who reached the server first.”
3. **WebSocket for the live session**, HTTP for initial sync / snapshot fetch when the gap is large or the socket is unavailable.
4. **Actor identity is server-assigned** and bound to the authenticated session / device. A browser cannot pretend to be another user.
5. **Local persistence (IndexedDB)** holds the actor counter and pending operations so a tab refresh does not lose work or reuse counters incorrectly.

---

## 4. Core Concepts Explained Simply

### 4.1 What is a CRDT?

A **Conflict-free Replicated Data Type** is a data structure that can be copied to many places, edited independently, and later merged so that every copy ends up the same — without needing a central lock or a single “winner” decided by arrival time.

In this engine the CRDT is **operation-based**: clients generate operations; every replica applies the same operations with the same deterministic rules.

### 4.2 Actor and Operation ID

- Every browser/device that can edit gets an **`actorId`** from the server after authentication.
- That actor keeps a private monotonic **`counter`** (1, 2, 3…).
- Every operation is identified by `{ actorId, counter }`.  
  This pair is unique for that actor and is the primary key for deduplication.

If the user clears site data and the counter is lost, the client must request a **new** actorId. Never reuse an old counter range with different payloads.

### 4.3 Vector Clock (Causality)

A **vector clock** is a map: `{ [actorId]: highestCounterSeen }`.

When you create an operation you attach the vector clock of everything you already knew about. Other replicas will only apply your operation once they have those dependencies. This prevents “delete a character that does not exist yet” from being applied too early.

### 4.4 Tombstones

When you delete a character we do **not** remove its node from the data structure immediately. We mark it deleted (a **tombstone**). This keeps the “position” stable so concurrent inserts that pointed at the deleted character still have a well-defined place to land, and descendants are never orphaned.

---

## 5. Data Model

### 5.1 Types in v1

| Type | CRDT used | When to use it |
|------|-----------|----------------|
| Text sequence | RGA | The main body of the document |
| Map fields | LWW register per key | Title, status, tags, settings — places where “last writer wins” is acceptable |
| Counters | PN-Counter (optional) | Vote counts, reaction tallies — never store these as plain LWW numbers |

### 5.2 TypeScript shapes

```ts
type ActorId = string;
type ElementId = { actorId: ActorId; counter: number };
type VectorClock = Record<ActorId, number>;

type CrdtOperation =
  | {
      kind: 'text.insert';
      opId: ElementId;
      deps: VectorClock;
      after: ElementId | 'ROOT';
      value: string;               // one Unicode scalar or chosen token
    }
  | {
      kind: 'text.delete';
      opId: ElementId;
      deps: VectorClock;
      target: ElementId;
    }
  | {
      kind: 'map.set';
      opId: ElementId;
      deps: VectorClock;
      key: string;
      value: JsonValue;
      logicalTime: number;         // Lamport clock
    }
  | {
      kind: 'map.delete';
      opId: ElementId;
      deps: VectorClock;
      key: string;
      logicalTime: number;
    };
```

### 5.3 Server validation (mandatory)

Before accepting any operation the server must check:

- Size limits (string length, total op size, document size)
- Actor binding (`opId.actorId` matches the authenticated principal)
- Counter monotonicity for that actor
- Document permission (`document:read` / `document:write`)
- Allowed keys / paths and value schema
- Dependency bounds (no references to the far future, pending set not unbounded)

---

## 6. How Text Collaboration Works (RGA)

### 6.1 Node shape

```ts
interface RgaNode {
  id: ElementId;
  after: ElementId | 'ROOT';
  value: string;
  deleted: boolean;
}
```

### 6.2 Insert

1. Client decides “insert this character after node X” (or after `ROOT` for the beginning).
2. It creates a new node with a fresh `opId` and the current dependency vector.
3. The node is applied locally immediately (optimistic UI).
4. The operation is sent to the server and broadcast to other clients.

**Concurrent inserts after the same node** are ordered by a stable total order on `(actorId, counter)`. Every browser must use the exact same comparison (bytewise on actorId, numeric on counter). This rule is part of the protocol and must not change without a schema version bump.

### 6.3 Delete

1. Mark the target node `deleted = true`.
2. Do not remove it from the tree yet.
3. Rendering skips the value but still walks children so nothing is orphaned.

If a delete arrives for a node the local replica has never seen, the operation is buffered (within a limit) until the missing insert arrives, or rejected as causally incomplete. It is never silently dropped.

### 6.4 Rendering the text

```
function render(nodesAfterRoot):
  result = ""
  for each child of ROOT, sorted by stable (actorId, counter):
    if not child.deleted:
      result += child.value
    result += render(children of this node)   // always recurse
  return result
```

This produces the same string on every replica that has the same set of operations.

### 6.5 Why this design for the web

- Inserts are anchored to existing content, which matches how users think (“type after this letter”).
- Tombstones keep positions stable under concurrent edits — critical when two people type in the same paragraph while offline.
- The algorithm is simple enough to implement and test thoroughly in TypeScript running in the browser.

---

## 7. How Metadata Fields Work (LWW Maps)

Some fields (document title, status, color, etc.) are naturally “last writer wins.” For those we use a per-key register ordered by:

```
(logicalTime, actorId, counter)
```

- `logicalTime` is a Lamport clock: `max(local, observed) + 1`.
- Actor and counter break ties deterministically.
- A delete is stored as a tombstone value for that key.

**Product note:** Concurrent map writes intentionally keep only one winner. Document this behavior so product and support teams are not surprised.

---

## 8. Identity, Operations, and Causality

### 8.1 Actor lifecycle (web)

1. User authenticates (cookie, Bearer token, etc.).
2. Server issues or reuses a durable `actorId` for that device/session.
3. Client loads the last used counter from IndexedDB.
4. Every new operation increments the counter and **persists it before** the UI treats the edit as committed.
5. If IndexedDB is cleared, client requests a new actorId.

### 8.2 Causal readiness

An operation is ready to apply when every entry in its `deps` vector is already known (the corresponding operations have been applied or the counters are covered by the local version vector).

- Ready → apply, update local version vector, notify UI.
- Not ready → put in a bounded pending buffer and, if the gap persists, request missing ranges from the server.

### 8.3 Idempotency and conflict detection

- Same `opId` + same payload → no-op (already applied).
- Same `opId` + different payload → protocol violation. Close the connection, quarantine the actor, emit security telemetry.

---

## 9. Sync Protocol for the Web

### 9.1 Typical session

1. Browser connects with an auth token and requests the document.
2. Client sends its current version vector (`have`).
3. Server replies with either:
   - The missing operations, or
   - A snapshot + operations after that snapshot (when the client is far behind).
4. Client applies everything that is causally ready and updates its vector.
5. Client starts sending new local operations over the WebSocket.
6. Server validates, persists, ACKs (only after durability), and broadcasts.
7. Other clients receive the ops, deduplicate by `opId`, and apply when ready.
8. On reconnect or tab wake-up, the client repeats the vector-clock handshake.  
   Do **not** rely only on “replay what the WebSocket missed.”

### 9.2 Message shapes

```ts
interface SyncRequest {
  documentId: string;
  schemaVersion: number;
  have: VectorClock;
}

interface SyncResponse {
  snapshot?: Snapshot;
  operations: CrdtOperation[];
  head: VectorClock;
}

interface OperationAck {
  opId: ElementId;
  status: 'persisted';          // only durable ACK for document ops
  head: VectorClock;
}
```

Avoid `accepted-ephemeral` for any edit the product promises to keep.

### 9.3 Transport recommendations

| Situation | Transport |
|-----------|-----------|
| Live editing session | WebSocket (binary or compact JSON) |
| Initial load / large gap | HTTP GET snapshot + ops |
| Background sync / service worker | HTTP POST ops + vector |
| Awareness (cursors) | Same WebSocket, separate message type, or a second lightweight channel |

---

## 10. Client SDK (Browser / Web App)

### 10.1 Public surface (TypeScript)

```ts
const engine = await CollaborationEngine.connect({
  documentId: string,
  authToken: string,
  schemaVersion: number,
  // Optional adapters
  storage?: LocalPersistence,     // IndexedDB wrapper
  transport?: Transport,          // WebSocket + HTTP fallback
});

// ---- Local edits (optimistic) ----
engine.insertText(after: ElementId | 'ROOT', value: string): ElementId;
engine.deleteText(target: ElementId): void;
engine.setMapField(key: string, value: JsonValue): void;
engine.deleteMapField(key: string): void;

// ---- Read current state ----
engine.getText(): string;
engine.getMap(): Record<string, JsonValue>;
engine.getVersionVector(): VectorClock;

// ---- Subscriptions ----
engine.onChange(cb: (state: MaterializedState) => void): Unsubscribe;
engine.onSyncStatus(cb: (status: SyncStatus) => void): Unsubscribe;

// ---- Awareness (ephemeral) ----
engine.setAwareness(state: AwarenessState): void;
engine.onAwareness(cb: (peers: AwarenessState[]) => void): Unsubscribe;

// ---- Lifecycle ----
engine.forceSync(): Promise<void>;
engine.disconnect(): Promise<void>;
```

### 10.2 Guarantees the SDK must provide

- Local operations receive a stable `opId` and are applied to the local model **before** being shown as committed in the UI.
- The actor counter is written to IndexedDB before the operation is considered durable locally.
- Remote operations are applied only when causally ready.
- The UI can always read a consistent materialized snapshot.
- Tab close / refresh does not lose pending operations that were already acknowledged locally.

### 10.3 Integration with a typical web editor

```
User types → editor captures insert/delete
           → engine.insertText / deleteText
           → engine applies locally → onChange fires
           → React / Vue / Svelte re-renders the text
           → engine sends op over WebSocket in background
```

Keep the editor’s own model and the CRDT model in sync through the `onChange` callback or a thin binding layer. Avoid letting the editor mutate the CRDT structure directly.

---

## 11. Server Responsibilities

| Responsibility | Why it matters for web collab |
|----------------|-------------------------------|
| Authentication & document ACL | Prevents unauthorized reads/writes |
| Operation validation | Protects against oversized or malformed ops |
| Durable append-only log | Source of truth for catch-up after refresh |
| Snapshots | Fast load for clients that are far behind |
| Fan-out to other connections | Real-time delivery to other browsers |
| Materialized state (optional) | Useful for search, export, server-side rendering |
| Rate limits & quotas | Protects the service from runaway clients |
| Multi-instance coordination | Sticky sessions or pub/sub so any server can serve the doc |

The server **may** sequence operations for storage efficiency, but the CRDT rules — not server arrival order — define the final document state.

---

## 12. Persistence, Snapshots, and Compaction

### 12.1 What is stored

- Append-only operation log (every accepted op)
- Periodic snapshots:
  - Schema version
  - Version vector
  - Full set of RGA nodes + map registers
  - Checksum

A write transaction should atomically record the operation and advance the document head (or use a durable log that can be replayed deterministically).

### 12.2 Compaction rules (critical)

You may only drop tombstones or old log entries when you can prove **no supported client still needs that causal history**.

Practical approach:

- Track per-actor acknowledged version vectors (retention leases).
- Define a maximum offline window (e.g. 30 days).
- Clients older than the window must load a fresh snapshot and cannot replay obsolete operations without validation.
- **Never** compact only because an operation is old by wall-clock time.

---

## 13. Awareness, Cursors, and Presence

Cursors, selections, “typing…”, and active-device lists are **not** part of the CRDT log.

| Property | Rule |
|----------|------|
| Channel | Separate message type on the same WebSocket (or a dedicated lightweight channel) |
| Reliability | Best-effort; may be coalesced or dropped |
| Lifetime | Short TTL; disappear when the tab closes or the lease expires |
| Validation | Cursor offsets must be checked against the current rendered document |
| Identity | Never trust a client-supplied display name or color without server verification |

This keeps the durable document log small and free of ephemeral noise.

---

## 14. Authorization and Security

| Rule | Rationale |
|------|-----------|
| ActorId comes from the authenticated principal | Stops identity spoofing |
| Check `document:read` / `document:write` on every join and every op | Room membership ≠ document permission |
| Validate size, nesting, string length, pending-queue depth | DoS and memory protection |
| Isolate awareness from the durable log | Prevents spam from polluting history |
| Treat same-opId-different-payload as a security event | Detects bugs or malicious clients |
| Document E2EE trade-offs explicitly | Server-side validation becomes harder or impossible if payloads are opaque |

---

## 15. Failure Handling

| Situation | Expected behavior |
|-----------|-------------------|
| Duplicate operation | Return the existing ACK; do not apply twice |
| Out-of-order operation | Buffer (bounded); request missing dependencies |
| Missing dependency past timeout | Force a resync; reject if the op is invalid or too old |
| Conflicting opId (same ID, different body) | Close connection, quarantine actor, emit telemetry |
| Storage backend down | Do **not** send a durable ACK |
| Browser goes offline | Keep pending ops in IndexedDB; sync on reconnect |
| Snapshot schema too new | Tell the client to upgrade; never silently reinterpret |
| Tab put to sleep / bfcache | On wake, run `forceSync()` with the current vector |

---

## 16. Implementation Roadmap

| Milestone | What to build | Why it matters |
|-----------|---------------|----------------|
| 1 | Actor IDs, vector clocks, canonical encoding, validators | Foundation for everything else |
| 2 | RGA insert / delete / deterministic render | Core text collaboration |
| 3 | Map LWW registers + tombstones | Metadata fields |
| 4 | Property-based convergence tests | Prove the algorithm before adding networking |
| 5 | Durable log, snapshots, reconnect sync, retention leases | Real web reliability |
| 6 | Auth, quotas, multi-instance fan-out, metrics | Operations & hardening |
| 7 | Richer CRDT types (marks, blocks…) | Only after semantics and migrations are specified |

### Suggested package layout

```
collaboration-engine/
├── packages/
│   ├── core/                 # Pure CRDT (runs in browser and Node)
│   │   ├── rga.ts
│   │   ├── map-lww.ts
│   │   ├── vector-clock.ts
│   │   ├── apply.ts
│   │   └── encode.ts
│   ├── client/               # Browser SDK
│   │   ├── engine.ts
│   │   ├── indexeddb.ts
│   │   ├── websocket-transport.ts
│   │   └── awareness.ts
│   ├── server/               # Node / edge handlers
│   │   ├── validator.ts
│   │   ├── op-log.ts
│   │   ├── snapshot.ts
│   │   └── sync-handler.ts
│   └── test/
│       ├── property-convergence.test.ts
│       └── concurrent-insert.test.ts
└── docs/
    └── COLLABORATION_ENGINE_ARCHITECTURE.md
```

---

## 17. Required Invariants and Testing

These must hold in every release:

- Same set of valid operations → identical state on every replica.
- Duplicates do not change state.
- Delivery order does not change the final state once dependencies are satisfied.
- Delete-before-insert is either buffered or rejected — never applied inconsistently.
- Concurrent inserts at the same anchor produce the same order in every runtime.
- Tombstoned parents never orphan their descendants.
- An actor counter is never reused with a different payload.
- Snapshot + later operations ≡ full log replay.
- Unauthorized users cannot read, write, or infer protected content.

**Testing strategy**

- Property-based tests that generate random operation sequences, shuffle delivery order, and inject duplicates.
- Fuzzing of the wire format and dependency vectors.
- A reference implementation of this spec used as an oracle.
- Integration tests for reconnect, large snapshot gaps, retention expiry, and ACL denial.
- Cross-browser tests if you ship multiple client platforms.

---

## 18. Observability

Useful metrics and events for a web deployment:

- Operations applied / rejected / buffered per document
- Pending-dependency queue depth
- Snapshot build time and size
- Client version-vector lag
- WebSocket connect / disconnect / reconnect rates
- Auth failures and protocol-violation events (security)
- IndexedDB write failures on the client (via telemetry)

Never log full document content by default.

---

## 19. Versioning and Evolution

- The CRDT algorithm, sibling ordering, and tombstone rules are a **protocol**. They are versioned together with the document schema.
- Changing ordering or merge behavior requires a schema version bump and a migration path.
- Clients that cannot understand a newer schema must be forced to upgrade; silent reinterpretation is forbidden.
- Compaction and retention policies are also versioned and documented.

---

## 20. Summary

The Collaboration Engine is a purpose-built, operation-based CRDT designed for **web real-time collaboration**:

- **RGA text** with deterministic concurrent insertion order and safe tombstones
- **LWW map fields** for metadata that can tolerate last-writer-wins
- Explicit causality via vector clocks
- Durable, authorized, compactable operation logs on the server
- Optimistic local application in the browser for instant typing feel
- Clear separation between durable document state and ephemeral awareness (cursors, presence)

It prioritizes correctness (convergence, causality, identity, authorization) and keeps the v1 surface small so the team can implement, test, and operate it confidently. Richer document models can be added later only when their CRDT semantics and migration story are fully specified.

---

*This document is the authoritative architecture reference for the Collaboration Engine. Implementation code must conform to the invariants and ordering rules defined here.*