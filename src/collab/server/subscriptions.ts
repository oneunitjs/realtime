/**
 * Collaboration Engine server-side: document subscription registry.
 *
 * Implements docs/collab/collaboration-engine-architecture-plan.md §9.2.
 *
 * Tracks which connections are subscribed to which document scopes, using
 * the composite document identity `{ tenantId, documentId }`. Provides
 * bidirectional bookkeeping so a disconnect handler can remove a connection
 * from every document it subscribed to without scanning all documents.
 */

import type { DocumentScope } from "./document-key.js";
import { documentScopeKey } from "./document-key.js";

export interface DocumentSubscriptions {
  subscribe(
    scope: DocumentScope,
    connectionId: string,
  ): void;

  unsubscribe(
    scope: DocumentScope,
    connectionId: string,
  ): void;

  members(
    scope: DocumentScope,
  ): readonly string[];

  removeConnection(
    connectionId: string,
  ): void;
}

/** In-memory document subscription registry. */
export class MemoryDocumentSubscriptions
  implements DocumentSubscriptions {
  private readonly documents = new Map<string, Set<string>>();
  private readonly connectionDocuments = new Map<string, Set<string>>();

  private key(scope: DocumentScope): string {
    return documentScopeKey(scope);
  }

  subscribe(scope: DocumentScope, connectionId: string): void {
    const key = this.key(scope);

    let members = this.documents.get(key);
    if (!members) {
      members = new Set();
      this.documents.set(key, members);
    }
    members.add(connectionId);

    let documents = this.connectionDocuments.get(connectionId);
    if (!documents) {
      documents = new Set();
      this.connectionDocuments.set(connectionId, documents);
    }
    documents.add(key);
  }

  unsubscribe(scope: DocumentScope, connectionId: string): void {
    const key = this.key(scope);

    const members = this.documents.get(key);
    members?.delete(connectionId);

    if (members?.size === 0) {
      this.documents.delete(key);
    }

    const documents = this.connectionDocuments.get(connectionId);
    documents?.delete(key);

    if (documents?.size === 0) {
      this.connectionDocuments.delete(connectionId);
    }
  }

  members(scope: DocumentScope): readonly string[] {
    return [
      ...(this.documents.get(this.key(scope)) ?? []),
    ];
  }

  removeConnection(connectionId: string): void {
    const documents = this.connectionDocuments.get(connectionId);

    if (!documents) {
      return;
    }

    for (const key of documents) {
      const members = this.documents.get(key);

      members?.delete(connectionId);

      if (members?.size === 0) {
        this.documents.delete(key);
      }
    }

    this.connectionDocuments.delete(connectionId);
  }
}
