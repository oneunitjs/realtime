/**
 * Collaboration Engine browser client SDK.
 *
 * Implements docs/collab/collaboration-engine.md §10 and
 * docs/collab/collaboration-engine-architecture-plan.md §6.
 */

export {
  CollaborationEngine,
} from "./engine.js";
import { CollaborationEngine } from "./engine.js";
import type { CollaborationEngineOptions } from "./engine.js";
export type {
  CollaborationEngineOptions,
} from "./engine.js";

export {
  Document,
  type DocumentState,
  type AwarenessPeer,
} from "./document.js";

export type {
  AwarenessState,
  SyncStatus,
} from "./engine.js";

export { MemoryStorage } from "./persistence.js";
export { IndexedDBStorage } from "./persistence.js";
export type { ClientStorage } from "./persistence.js";
export type { PendingOp, PersistedActor } from "./persistence.js";

export { FakeTransport } from "./transport.js";
export type { Transport } from "./transport.js";
export type { TransportMessage } from "./transport.js";

/**
 * Client-side collaboration client.
 *
 * Provides document-oriented access to collaboration features:
 *
 *   const client = createCollaborationClient({
   *     documentId: "doc-123",
   *     authToken: "token",
   *     schemaVersion: 1,
   *   });
   *
 *   await client.connect();
   *   const doc = client.document("doc-123");
   *   await doc.open();
   *   doc.text.insert(0, "Hello World");
   */
export function createCollaborationClient(options: CollaborationEngineOptions): CollaborationEngine {
  return new CollaborationEngine(options);
}

