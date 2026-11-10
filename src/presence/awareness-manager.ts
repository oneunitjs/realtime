/**
 * Awareness Manager — Typing, cursor, and collaboration awareness.
 *
 * Awareness signals are short-lived, ephemeral events that are NOT stored
 * as durable presence and NOT written to the Collaboration Engine CRDT
 * log. They travel on a separate, highly rate-limited path.
 *
 * Signals are cleared when:
 *   - Connection disconnects
 *   - User leaves a room
 *   - User switches documents
 *   - TTL expires
 */

import type {
  AwarenessCursorUpdate,
  AwarenessCursorUpdated,
  AwarenessEvent,
  AwarenessTypingStart,
  AwarenessTypingStop,
  AwarenessTypingUpdated,
  PresenceConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Awareness state
// ---------------------------------------------------------------------------

/**
 * Typing state for a user in a room.
 */
interface TypingState {
  userId: string;
  roomId: string;
  isTyping: boolean;
  expiresAt: number;
}

/**
 * Cursor state for a user in a room/document.
 */
interface CursorState {
  userId: string;
  roomId: string;
  documentId: string;
  cursor: unknown;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Awareness Manager
// ---------------------------------------------------------------------------

export class AwarenessManager {
  private readonly typingStates = new Map<string, TypingState>(); // key: `${userId}:${roomId}`
  private readonly cursorStates = new Map<string, CursorState>(); // key: `${userId}:${roomId}:${documentId}`
  private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly cursorTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly typingTtlMs: number;
  private readonly cursorTtlMs: number;
  private readonly onAwarenessEvent: (event: AwarenessEvent, roomId: string) => void;

  constructor(
    config: PresenceConfig,
    onAwarenessEvent: (event: AwarenessEvent, roomId: string) => void,
  ) {
    // Typing TTL: short, typically 3-5 seconds
    this.typingTtlMs = 5_000;
    // Cursor TTL: slightly longer, typically 10-30 seconds
    this.cursorTtlMs = 30_000;
    this.onAwarenessEvent = onAwarenessEvent;
  }

  // ------------------------------------------------------------------
  // Typing
  // ------------------------------------------------------------------

  /**
   * Handle a typing start event from a client.
   */
  typingStart(event: AwarenessTypingStart, userId: string): void {
    const key = `${userId}:${event.roomId}`;
    const now = Date.now();

    // Clear existing timer
    this.clearTypingTimer(key);

    const state: TypingState = {
      userId,
      roomId: event.roomId,
      isTyping: true,
      expiresAt: now + this.typingTtlMs,
    };

    this.typingStates.set(key, state);

    // Publish typing started
    this.publishTypingUpdated(userId, event.roomId, true);

    // Auto-expire after TTL
    this.setTypingTimer(key, this.typingTtlMs);
  }

  /**
   * Handle a typing stop event from a client.
   */
  typingStop(event: AwarenessTypingStop, userId: string): void {
    const key = `${userId}:${event.roomId}`;
    this.clearTypingTimer(key);
    this.typingStates.delete(key);

    // Publish typing stopped
    this.publishTypingUpdated(userId, event.roomId, false);
  }

  /**
   * Get all currently typing users in a room.
   */
  getTypingUsers(roomId: string): string[] {
    const now = Date.now();
    const typing: string[] = [];

    for (const [key, state] of this.typingStates) {
      if (state.roomId === roomId && state.isTyping && state.expiresAt > now) {
        typing.push(state.userId);
      }
    }

    return typing;
  }

  // ------------------------------------------------------------------
  // Cursor
  // ------------------------------------------------------------------

  /**
   * Handle a cursor update event from a client.
   */
  cursorUpdate(event: AwarenessCursorUpdate, userId: string): void {
    const key = `${userId}:${event.roomId}:${event.documentId}`;
    const now = Date.now();

    // Clear existing timer
    this.clearCursorTimer(key);

    const state: CursorState = {
      userId,
      roomId: event.roomId,
      documentId: event.documentId,
      cursor: event.cursor,
      expiresAt: now + this.cursorTtlMs,
    };

    this.cursorStates.set(key, state);

    // Publish cursor updated
    this.publishCursorUpdated(userId, event.roomId, event.documentId, event.cursor);

    // Auto-expire after TTL
    this.setCursorTimer(key, this.cursorTtlMs);
  }

  /**
   * Get all cursor states for a room/document.
   */
  getCursorStates(roomId: string, documentId?: string): Array<{
    userId: string;
    cursor: unknown;
  }> {
    const now = Date.now();
    const cursors: Array<{ userId: string; cursor: unknown }> = [];

    for (const [key, state] of this.cursorStates) {
      if (
        state.roomId === roomId &&
        (!documentId || state.documentId === documentId) &&
        state.expiresAt > now
      ) {
        cursors.push({
          userId: state.userId,
          cursor: state.cursor,
        });
      }
    }

    return cursors;
  }

  // ------------------------------------------------------------------
  // Cleanup
  // ------------------------------------------------------------------

  /**
   * Clear all awareness state for a user in a room (on disconnect or leave).
   */
  clearUserRoomAwareness(userId: string, roomId: string): void {
    // Clear typing
    const typingKey = `${userId}:${roomId}`;
    this.clearTypingTimer(typingKey);
    this.typingStates.delete(typingKey);
    this.publishTypingUpdated(userId, roomId, false);

    // Clear cursors for all documents in this room
    for (const [key, state] of this.cursorStates) {
      if (state.userId === userId && state.roomId === roomId) {
        this.clearCursorTimer(key);
        this.cursorStates.delete(key);
        this.publishCursorUpdated(
          userId,
          roomId,
          state.documentId,
          null, // null cursor indicates cleared
        );
      }
    }
  }

  /**
   * Clear awareness for a specific document.
   */
  clearDocumentAwareness(userId: string, roomId: string, documentId: string): void {
    const key = `${userId}:${roomId}:${documentId}`;
    this.clearCursorTimer(key);
    this.cursorStates.delete(key);

    const state = this.cursorStates.get(key);
    if (state) {
      this.publishCursorUpdated(userId, roomId, documentId, null);
    }
  }

  /**
   * Sweep expired awareness state (called periodically).
   */
  sweep(): void {
    const now = Date.now();

    // Sweep typing
    for (const [key, state] of this.typingStates) {
      if (now > state.expiresAt) {
        this.typingStates.delete(key);
        this.clearTypingTimer(key);
        this.publishTypingUpdated(state.userId, state.roomId, false);
      }
    }

    // Sweep cursors
    for (const [key, state] of this.cursorStates) {
      if (now > state.expiresAt) {
        this.cursorStates.delete(key);
        this.clearCursorTimer(key);
        this.publishCursorUpdated(
          state.userId,
          state.roomId,
          state.documentId,
          null,
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private publishTypingUpdated(
    userId: string,
    roomId: string,
    isTyping: boolean,
  ): void {
    const event: AwarenessTypingUpdated = {
      type: "awareness.typing.updated",
      roomId,
      userId,
      isTyping,
    };

    this.onAwarenessEvent(event, roomId);
  }

  private publishCursorUpdated(
    userId: string,
    roomId: string,
    documentId: string,
    cursor: unknown,
  ): void {
    const event: AwarenessCursorUpdated = {
      type: "awareness.cursor.updated",
      roomId,
      documentId,
      userId,
      cursor,
    };

    this.onAwarenessEvent(event, roomId);
  }

  private setTypingTimer(key: string, ttlMs: number): void {
    this.clearTypingTimer(key);
    this.typingTimers.set(
      key,
      setTimeout(() => {
        this.typingTimers.delete(key);
        const state = this.typingStates.get(key);
        if (state) {
          this.typingStates.delete(key);
          this.publishTypingUpdated(state.userId, state.roomId, false);
        }
      }, ttlMs),
    );
  }

  private setCursorTimer(key: string, ttlMs: number): void {
    this.clearCursorTimer(key);
    this.cursorTimers.set(
      key,
      setTimeout(() => {
        this.cursorTimers.delete(key);
        const state = this.cursorStates.get(key);
        if (state) {
          this.cursorStates.delete(key);
          this.publishCursorUpdated(
            state.userId,
            state.roomId,
            state.documentId,
            null,
          );
        }
      }, ttlMs),
    );
  }

  private clearTypingTimer(key: string): void {
    const timer = this.typingTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.typingTimers.delete(key);
    }
  }

  private clearCursorTimer(key: string): void {
    const timer = this.cursorTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.cursorTimers.delete(key);
    }
  }
}
