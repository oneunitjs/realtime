/**
 * Document Subscription Adapter.
 *
 * Bridges the Core Hub's document subscription interface to the consolidated
 * Collaboration subsystem (`src/collab/`). The Core Hub tracks which
 * connections subscribe to which documents for fan-out; the collab engine
 * owns document state (CRDT operations, sync, etc.).
 *
 * This adapter maintains the subscription index locally for fast lookup by
 * the Hub, while delegating document lifecycle to collab where available.
 */
import type { Principal } from "../connection/connection.types.js";

export interface DocumentSubscription {
  connectionId: string;
  documentId: string;
  tenantId: string;
  permission: "read" | "write";
  subscribedAt: number;
}

export class DocumentAdapter {
  // documentId -> Set<connectionId>
  private readonly docSubscribers = new Map<string, Set<string>>();
  // connectionId -> Set<documentId>
  private readonly connDocuments = new Map<string, Set<string>>();
  // documentId -> Map<connectionId, DocumentSubscription>
  private readonly subscriptions = new Map<string, Map<string, DocumentSubscription>>();

  /** Subscribe a connection to a document. */
  subscribe(
    connectionId: string,
    principal: Principal,
    documentId: string,
    tenantId: string,
    permission: "read" | "write",
  ): void {
    // Idempotent: already subscribed
    const existing = this.subscriptions.get(documentId);
    if (existing?.has(connectionId)) {
      return;
    }

    let docConns = this.docSubscribers.get(documentId);
    if (!docConns) {
      docConns = new Set();
      this.docSubscribers.set(documentId, docConns);
    }
    docConns.add(connectionId);

    let connDocs = this.connDocuments.get(connectionId);
    if (!connDocs) {
      connDocs = new Set();
      this.connDocuments.set(connectionId, connDocs);
    }
    connDocs.add(documentId);

    let subs = this.subscriptions.get(documentId);
    if (!subs) {
      subs = new Map();
      this.subscriptions.set(documentId, subs);
    }
    subs.set(connectionId, {
      connectionId,
      documentId,
      tenantId,
      permission,
      subscribedAt: Date.now(),
    });
  }

  /** Unsubscribe a connection from a document. */
  unsubscribe(connectionId: string, documentId: string): void {
    const subs = this.subscriptions.get(documentId);
    if (!subs?.has(connectionId)) {
      return;
    }
    subs.delete(connectionId);
    if (subs.size === 0) {
      this.subscriptions.delete(documentId);
    }

    const docConns = this.docSubscribers.get(documentId);
    if (docConns) {
      docConns.delete(connectionId);
      if (docConns.size === 0) {
        this.docSubscribers.delete(documentId);
      }
    }

    const connDocs = this.connDocuments.get(connectionId);
    if (connDocs) {
      connDocs.delete(documentId);
      if (connDocs.size === 0) {
        this.connDocuments.delete(connectionId);
      }
    }
  }

  /** Get all connection IDs subscribed to a document. */
  subscribers(documentId: string): string[] {
    const conns = this.docSubscribers.get(documentId);
    return conns ? [...conns] : [];
  }

  /** Remove all document subscriptions for a connection. Returns document IDs. */
  removeAllForConnection(connectionId: string): string[] {
    const docs = this.connDocuments.get(connectionId) ?? new Set();
    const result: string[] = [];
    for (const documentId of docs) {
      this.unsubscribe(connectionId, documentId);
      result.push(documentId);
    }
    return result;
  }

  /** Total number of subscriptions across all documents. */
  total(): number {
    let count = 0;
    for (const subs of this.subscriptions.values()) {
      count += subs.size;
    }
    return count;
  }

  /** Count subscribers to a document. */
  count(documentId: string): number {
    const subs = this.subscriptions.get(documentId);
    return subs?.size ?? 0;
  }
}
