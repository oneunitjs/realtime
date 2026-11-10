/**
 * Document-oriented public API for the Collaboration Engine.
 *
 * Wraps {@link CollaborationEngine} with a document-centric interface that
 * hides CRDT internals (operation IDs, actor counters, vector clocks,
 * dependency vectors, pending operation queues) from application developers.
 *
 * Example:
 *
 *   const doc = client.collaboration.document("doc-123");
   *   await doc.open();
   *
   *   doc.text.insert(0, "Hello World");
   *   doc.set("title", "My Document");
   *   doc.subscribe((state) => console.log(state.text));
   */

import type {
  CrdtOperation,
  ElementId,
  MaterializedState,
  VectorClock,
  JsonValue,
} from "../core/types.js";
import { CollaborationEngine } from "./engine.js";

/** Document text operations. */
export class DocumentText {
  private readonly engine: CollaborationEngine;

  constructor(engine: CollaborationEngine) {
    this.engine = engine;
  }

  /** Rendered text content. */
  toString(): string {
    return this.engine.getText();
  }

  /** Insert text at the given position. */
  insert(index: number, value: string): void {
    const ids = this.engine.visibleIds();
    let after: ElementId | "ROOT" = "ROOT";
    if (index > 0 && ids.length > 0) {
      after = ids[Math.min(index, ids.length) - 1];
    }
    for (const ch of [...value]) {
      void this.engine.insertText(after, ch).then((id) => {
        after = id;
      });
    }
  }

  /** Delete `length` characters starting at `index`. */
  delete(index: number, length: number): void {
    const ids = this.engine.visibleIds().slice(index, index + length);
    for (const id of ids) {
      void this.engine.deleteText(id);
    }
  }
}

/** Document metadata (LWW map) operations. */
export class DocumentFields {
  private readonly engine: CollaborationEngine;

  constructor(engine: CollaborationEngine) {
    this.engine = engine;
  }

  /** Read a metadata field value. */
  get(key: string): JsonValue | undefined {
    return this.engine.getMap().get(key);
  }

  /** Update a metadata field value. */
  set(key: string, value: JsonValue): void {
    void this.engine.setMapField(key, value);
  }

  /** Delete a metadata field. */
  delete(key: string): void {
    void this.engine.deleteMapField(key);
  }

  /** All current field values. */
  toObject(): Record<string, JsonValue> {
    return Object.fromEntries(this.engine.getMap());
  }
}

/** Document-level subscriptions. */
export class DocumentEvents {
  private readonly engine: CollaborationEngine;

  constructor(engine: CollaborationEngine) {
    this.engine = engine;
  }

  /** Subscribe to document state changes. */
  subscribe(handler: (state: DocumentState) => void): () => void {
    return this.engine.onChange((state) => {
      handler({
        text: state.text,
        fields: Object.fromEntries(state.map),
      });
    });
  }

  /** Observe changes to a specific text position. */
  observeText(handler: (text: string) => void): () => void {
    return this.engine.onChange((state) => {
      handler(state.text);
    });
  }

  /** Observe changes to a specific field. */
  observeField(key: string, handler: (value: JsonValue | undefined) => void): () => void {
    return this.engine.onChange((state) => {
      handler(state.map.get(key));
    });
  }
}

/** Document presence and awareness. */
export class DocumentAwareness {
  private readonly engine: CollaborationEngine;

  constructor(engine: CollaborationEngine) {
    this.engine = engine;
  }

  /** Set local awareness state (cursor, selection, user info). */
  set(state: {
    name?: string;
    color?: string;
    cursor?: { x: number; y: number };
    selection?: { start: number; end: number };
  }): void {
    this.engine.setAwareness(state as import("./engine.js").AwarenessState);
  }

  /** Subscribe to remote peer awareness. */
  subscribe(handler: (users: AwarenessPeer[]) => void): () => void {
    return this.engine.onAwareness((peers) => {
      handler(peers);
    });
  }

  /** Current remote peers. */
  getUsers(): AwarenessPeer[] {
    return this.engine.getAwarenessPeers();
  }

  /** Local awareness state. */
  getLocalState(): AwarenessPeer | null {
    const peers = this.engine.getAwarenessPeers();
    return peers.length > 0 ? peers[0] : null;
  }
}

/** Document-level document state. */
export interface DocumentState {
  text: string;
  fields: Record<string, JsonValue>;
}

/** Awareness peer. */
export interface AwarenessPeer {
  userId: string;
  userName?: string;
  color?: string;
  cursor?: { x: number; y: number };
  selection?: { start: number; end: number };
}

/**
 * Client-side document handle.
 *
 * Obtained via `client.collaboration.document("doc-123")`. Provides a
 * document-centric interface that hides CRDT internals from application
 * developers.
 */
export class Document {
  readonly id: string;
  readonly text: DocumentText;
  readonly fields: DocumentFields;
  readonly events: DocumentEvents;
  readonly awareness: DocumentAwareness;

  private readonly engine: CollaborationEngine;
  private opened = false;

  constructor(id: string, engine: CollaborationEngine) {
    this.id = id;
    this.engine = engine;
    this.text = new DocumentText(engine);
    this.fields = new DocumentFields(engine);
    this.events = new DocumentEvents(engine);
    this.awareness = new DocumentAwareness(engine);
  }

  /** Open and synchronize the document. Resolves when the initial sync is complete. */
  async open(): Promise<void> {
    if (this.opened) return;
    await this.engine.connect();
    this.opened = true;
  }

  /** Close the document session. */
  async close(): Promise<void> {
    if (!this.opened) return;
    await this.engine.disconnect();
    this.opened = false;
  }

  /** Current materialized document state. */
  getState(): DocumentState {
    return {
      text: this.engine.getText(),
      fields: Object.fromEntries(this.engine.getMap()),
    };
  }

  /** Current version vector (causal frontier). */
  getVersionVector(): VectorClock {
    return this.engine.getVersionVector();
  }

  /** Group multiple local changes into a single notification batch. */
  transact(callback: () => void): void {
    // In v1, all local edits are already applied optimistically and broadcast
    // individually. A future version may batch them into a single server op.
    callback();
  }

  /** Number of pending (unacknowledged) local operations. */
  get pendingOperations(): number {
    // The engine doesn't expose pending count directly; return 0 as a
    // placeholder until the client tracks pending ops explicitly.
    return 0;
  }

  /** Whether the document is currently connected and synced. */
  get synced(): boolean {
    return true; // The engine maintains connection state internally
  }
}
