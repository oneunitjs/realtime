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
 *
 * All document indexes are keyed by tenant-qualified document keys so that
 * two tenants can independently use the same document ID without collision.
 */
import type { Principal } from "../connection/connection.types.js";

export interface DocumentSubscription {
  connectionId: string;
  documentId: string;
  tenantId: string;
  permission: "read" | "write";
  subscribedAt: number;
}

const FIELD_SEPARATOR = "\u001F";

/**
 * Encode a tenant-qualified document key.
 *
 * Format: <len(tenantId)>:\u001F<tenantId>\u001F<len(documentId)>:\u001F<documentId>
 */
export function encodeDocumentKey(tenantId: string, documentId: string): string {
  return (
    String(tenantId.length) +
    FIELD_SEPARATOR +
    tenantId +
    FIELD_SEPARATOR +
    String(documentId.length) +
    FIELD_SEPARATOR +
    documentId
  );
}

/**
 * Decode a tenant-qualified document key back into its components.
 * Returns null if the key is malformed.
 */
export function decodeDocumentKey(docKey: string): {
  tenantId: string;
  documentId: string;
} | null {
  let offset = 0;

  const readField = (): string | null => {
    let lenStr = "";
    while (offset < docKey.length && docKey[offset] !== FIELD_SEPARATOR) {
      lenStr += docKey[offset];
      offset++;
    }

    if (offset >= docKey.length) {
      return null;
    }

    offset++; // skip separator

    const len = parseInt(lenStr, 10);
    if (isNaN(len) || len < 0) {
      return null;
    }

    if (offset + len > docKey.length) {
      return null;
    }

    const field = docKey.slice(offset, offset + len);
    offset += len;

    if (offset < docKey.length && docKey[offset] === FIELD_SEPARATOR) {
      offset++;
    }

    return field;
  };

  const tenantId = readField();
  const documentId = readField();

  if (tenantId === null || documentId === null) {
    return null;
  }

  if (offset !== docKey.length) {
    return null;
  }

  return { tenantId, documentId };
}

export class DocumentAdapter {
  // documentKey -> Set<connectionId>
  private readonly docSubscribers = new Map<string, Set<string>>();
  // connectionId -> Set<documentKey>
  private readonly connDocuments = new Map<string, Set<string>>();
  // documentKey -> Map<connectionId, DocumentSubscription>
  private readonly subscriptions = new Map<
    string,
    Map<string, DocumentSubscription>
  >();

  /** Subscribe a connection to a document. */
  subscribe(
    connectionId: string,
    principal: Principal,
    documentId: string,
    tenantId: string,
    permission: "read" | "write",
  ): void {
    const docKey = encodeDocumentKey(tenantId, documentId);

    // Idempotent: already subscribed
    const existing = this.subscriptions.get(docKey);
    if (existing?.has(connectionId)) {
      return;
    }

    let docConns = this.docSubscribers.get(docKey);
    if (!docConns) {
      docConns = new Set();
      this.docSubscribers.set(docKey, docConns);
    }
    docConns.add(connectionId);

    let connDocs = this.connDocuments.get(connectionId);
    if (!connDocs) {
      connDocs = new Set();
      this.connDocuments.set(connectionId, connDocs);
    }
    connDocs.add(docKey);

    let subs = this.subscriptions.get(docKey);
    if (!subs) {
      subs = new Map();
      this.subscriptions.set(docKey, subs);
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
  unsubscribe(connectionId: string, documentId: string, tenantId?: string): void {
    const docKey =
      tenantId !== undefined
        ? encodeDocumentKey(tenantId, documentId)
        : this.findDocKeyForConnection(connectionId, documentId);
    if (!docKey) {
      return;
    }

    const subs = this.subscriptions.get(docKey);
    if (!subs?.has(connectionId)) {
      return;
    }
    subs.delete(connectionId);
    if (subs.size === 0) {
      this.subscriptions.delete(docKey);
    }

    const docConns = this.docSubscribers.get(docKey);
    if (docConns) {
      docConns.delete(connectionId);
      if (docConns.size === 0) {
        this.docSubscribers.delete(docKey);
      }
    }

    const connDocs = this.connDocuments.get(connectionId);
    if (connDocs) {
      connDocs.delete(docKey);
      if (connDocs.size === 0) {
        this.connDocuments.delete(connectionId);
      }
    }
  }

  /** Get all connection IDs subscribed to a tenant-qualified document. */
  subscribers(docKey: string): string[] {
    const conns = this.docSubscribers.get(docKey);
    return conns ? [...conns] : [];
  }

  /** Get all connection IDs subscribed to a document by bare documentId. */
  subscribersByDocumentId(documentId: string): string[] {
    const result: string[] = [];
    for (const [docKey, conns] of this.docSubscribers) {
      const decoded = decodeDocumentKey(docKey);
      if (decoded && decoded.documentId === documentId) {
        for (const connId of conns) {
          result.push(connId);
        }
      }
    }
    return result;
  }

  /** Remove all document subscriptions for a connection. Returns document IDs. */
  removeAllForConnection(connectionId: string): string[] {
    const docs = this.connDocuments.get(connectionId) ?? new Set();
    const result: string[] = [];
    for (const docKey of docs) {
      const decoded = decodeDocumentKey(docKey);
      if (decoded) {
        result.push(decoded.documentId);
      }
      this.unsubscribeByDocKey(connectionId, docKey);
    }
    return result;
  }

  private unsubscribeByDocKey(connectionId: string, docKey: string): void {
    const subs = this.subscriptions.get(docKey);
    if (subs) {
      subs.delete(connectionId);
      if (subs.size === 0) {
        this.subscriptions.delete(docKey);
      }
    }
    const docConns = this.docSubscribers.get(docKey);
    if (docConns) {
      docConns.delete(connectionId);
      if (docConns.size === 0) {
        this.docSubscribers.delete(docKey);
      }
    }
    const connDocs = this.connDocuments.get(connectionId);
    if (connDocs) {
      connDocs.delete(docKey);
      if (connDocs.size === 0) {
        this.connDocuments.delete(connectionId);
      }
    }
  }

  /** Get the subscription for a connection on a document (by bare documentId). */
  getSubscription(documentId: string, connectionId: string): DocumentSubscription | undefined {
    for (const [docKey, subs] of this.subscriptions) {
      const decoded = decodeDocumentKey(docKey);
      if (decoded && decoded.documentId === documentId) {
        return subs.get(connectionId);
      }
    }
    return undefined;
  }

  /** Total number of subscriptions across all documents. */
  total(): number {
    let count = 0;
    for (const subs of this.subscriptions.values()) {
      count += subs.size;
    }
    return count;
  }

  /** Total number of documents with at least one subscriber. */
  documentCount(): number {
    return this.docSubscribers.size;
  }

  /** Count subscribers to a document by bare documentId. */
  count(documentId: string): number {
    return this.subscribersByDocumentId(documentId).length;
  }

  /** Find a docKey for a connection and bare documentId. */
  private findDocKeyForConnection(
    connectionId: string,
    documentId: string,
  ): string | undefined {
    for (const [docKey] of this.subscriptions) {
      const decoded = decodeDocumentKey(docKey);
      if (decoded && decoded.documentId === documentId) {
        const subs = this.subscriptions.get(docKey);
        if (subs?.has(connectionId)) {
          return docKey;
        }
      }
    }
    return undefined;
  }
}
