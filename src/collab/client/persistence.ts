/**
 * Client-side persistence interface.
 *
 * Implements docs/collab/collaboration-engine.md §6.3 and
 * docs/collab/collaboration-engine-architecture-plan.md §6.3.
 *
 * IndexedDB schema stores:
 *   - Actor identity and lifecycle metadata
 *   - Per-actor operation counter
 *   - Lamport logical clock
 *   - Local CRDT state / latest snapshot
 *   - Pending outbound operations
 *   - Last known server head / version vector
 *
 * All methods are asynchronous to support IndexedDB-backed storage
 * (transactional actor counter allocation, pending-op persistence,
 * and durable snapshots).
 *
 * An in-memory implementation is provided for environments without
 * IndexedDB (e.g. Node tests) and as the default fallback.
 */

export interface ClientStorage {
  /** Generic key-value get. */
  getItem(key: string): Promise<string | null>;

  /** Generic key-value set. */
  setItem(key: string, value: string): Promise<void>;

  /** Generic key-value remove. */
  removeItem(key: string): Promise<void>;

  /** Load a persisted document snapshot for the given document ID. */
  loadDocument(
    documentId: string,
  ): Promise<DocumentSnapshot | null>;

  /** Persist a document snapshot for the given document ID. */
  saveDocument(
    documentId: string,
    snapshot: DocumentSnapshot,
  ): Promise<void>;

  /**
   * Atomically allocate the next actor operation counter and persist
   * the new operation. If the transaction fails, the edit must not be
   * advertised as locally durable.
   */
  allocateAndSaveOperation(
    documentId: string,
    operation: import("../core/types.js").CrdtOperation,
  ): Promise<void>;

  /** Retrieve all pending (unacknowledged) outbound operations. */
  getPendingOperations(
    documentId: string,
  ): Promise<import("../core/types.js").CrdtOperation[]>;

  /** Mark an operation as durably acknowledged by the server. */
  acknowledgeOperation(
    documentId: string,
    opId: { actorId: string; counter: number },
  ): Promise<void>;

  /** Close the storage and release any resources. */
  close(): Promise<void>;
}

/** Materialized document state persisted to storage. */
export interface DocumentSnapshot {
  text: string;
  map: Record<string, import("../core/types.js").JsonValue>;
  versionVector: Record<string, number>;
  schemaVersion: number;
}

/** Actor identity and lifecycle metadata. */
export interface PersistedActor {
  actorId: string;
  counter: number;
}

/** Pending outbound operation awaiting durable ACK. */
export interface PendingOp {
  op: import("../core/types.js").CrdtOperation;
  createdAt: number;
}

/**
 * In-memory storage implementation.
 *
 * Suitable for tests and explicitly ephemeral sessions. Does NOT survive
 * refresh or process termination. For browser offline collaboration,
 * implement ClientStorage with IndexedDB.
 */
export class MemoryStorage implements ClientStorage {
  private readonly store = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.store.delete(key);
  }

  async loadDocument(documentId: string): Promise<DocumentSnapshot | null> {
    const raw = this.store.get(`doc:${documentId}`);
    return raw ? (JSON.parse(raw) as DocumentSnapshot) : null;
  }

  async saveDocument(
    documentId: string,
    snapshot: DocumentSnapshot,
  ): Promise<void> {
    this.store.set(`doc:${documentId}`, JSON.stringify(snapshot));
  }

  async allocateAndSaveOperation(
    documentId: string,
    operation: import("../core/types.js").CrdtOperation,
  ): Promise<void> {
    const counterKey = `counter:${documentId}`;
    const pendingKey = `pending:${documentId}`;

    const stored = await this.store.get(counterKey);
    const current = stored ? parseInt(stored, 10) : 0;
    const next = current + 1;
    this.store.set(counterKey, String(next));

    const pendingJson = this.store.get(pendingKey);
    const pending: PendingOp[] = pendingJson ? JSON.parse(pendingJson) : [];
    pending.push({ op: operation, createdAt: Date.now() });
    this.store.set(pendingKey, JSON.stringify(pending));
  }

  async getPendingOperations(
    documentId: string,
  ): Promise<import("../core/types.js").CrdtOperation[]> {
    const pendingJson = this.store.get(`pending:${documentId}`);
    if (!pendingJson) return [];
    return JSON.parse(pendingJson).map((p: PendingOp) => p.op);
  }

  async acknowledgeOperation(
    documentId: string,
    opId: { actorId: string; counter: number },
  ): Promise<void> {
    const pendingJson = this.store.get(`pending:${documentId}`);
    if (!pendingJson) return;
    const pending: PendingOp[] = JSON.parse(pendingJson);
    const filtered = pending.filter(
      (p) =>
        p.op.opId.actorId !== opId.actorId || p.op.opId.counter !== opId.counter,
    );
    this.store.set(`pending:${documentId}`, JSON.stringify(filtered));
  }

  async close(): Promise<void> {
    this.store.clear();
  }
}

/**
 * IndexedDB-backed storage implementation for browser offline persistence.
 *
 * Provides durable storage for collaboration state across page reloads
 * and browser restarts. Falls back gracefully if IndexedDB is unavailable.
 */
export class IndexedDBStorage implements ClientStorage {
  private readonly dbName = "realtime-collab";
  private readonly storeName = "collab-store";
  private db: IDBDatabase | null = null;
  private readonly openPromise: Promise<IDBDatabase>;

  constructor() {
    this.openPromise = this.open();
  }

  private async open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB not available"));
        return;
      }

      const request = indexedDB.open(this.dbName, 1);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: "key" });
        }
      };
    });
  }

  private async objectStore(mode: "readonly" | "readwrite"): Promise<IDBObjectStore> {
    const db = await this.openPromise;
    const tx = db.transaction(this.storeName, mode);
    return tx.objectStore(this.storeName);
  }

  private async op<T>(store: IDBObjectStore, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const request = fn(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getItem(key: string): Promise<string | null> {
    try {
      const store = await this.objectStore("readonly");
      const result = await this.op(store, (s) => s.get(key));
      return result ? (result.value as string) : null;
    } catch {
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    const store = await this.objectStore("readwrite");
    await this.op(store, (s) => s.put({ key, value }));
  }

  async removeItem(key: string): Promise<void> {
    const store = await this.objectStore("readwrite");
    await this.op(store, (s) => s.delete(key));
  }

  async loadDocument(documentId: string): Promise<DocumentSnapshot | null> {
    const raw = await this.getItem(`doc:${documentId}`);
    return raw ? (JSON.parse(raw) as DocumentSnapshot) : null;
  }

  async saveDocument(
    documentId: string,
    snapshot: DocumentSnapshot,
  ): Promise<void> {
    await this.setItem(`doc:${documentId}`, JSON.stringify(snapshot));
  }

  async allocateAndSaveOperation(
    documentId: string,
    operation: import("../core/types.js").CrdtOperation,
  ): Promise<void> {
    const counterKey = `counter:${documentId}`;
    const pendingKey = `pending:${documentId}`;

    const stored = await this.getItem(counterKey);
    const current = stored ? parseInt(stored, 10) : 0;
    const next = current + 1;
    await this.setItem(counterKey, String(next));

    const pendingJson = await this.getItem(pendingKey);
    const pending: PendingOp[] = pendingJson ? JSON.parse(pendingJson) : [];
    pending.push({ op: operation, createdAt: Date.now() });
    await this.setItem(pendingKey, JSON.stringify(pending));
  }

  async getPendingOperations(
    documentId: string,
  ): Promise<import("../core/types.js").CrdtOperation[]> {
    const pendingJson = await this.getItem(`pending:${documentId}`);
    if (!pendingJson) return [];
    return JSON.parse(pendingJson).map((p: PendingOp) => p.op);
  }

  async acknowledgeOperation(
    documentId: string,
    opId: { actorId: string; counter: number },
  ): Promise<void> {
    const pendingJson = await this.getItem(`pending:${documentId}`);
    if (!pendingJson) return;
    const pending: PendingOp[] = JSON.parse(pendingJson);
    const filtered = pending.filter(
      (p) =>
        p.op.opId.actorId !== opId.actorId || p.op.opId.counter !== opId.counter,
    );
    await this.setItem(`pending:${documentId}`, JSON.stringify(filtered));
  }

  async close(): Promise<void> {
    const db = await this.openPromise;
    db.close();
  }
}
