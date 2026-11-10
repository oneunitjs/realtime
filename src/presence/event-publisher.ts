/**
 * Event Publisher — Publishes presence and awareness events to subscribers.
 *
 * The event subsystem distributes meaningful changes to authorized
 * subscribers. It should NOT publish every heartbeat — only meaningful
 * presence deltas and awareness signals.
 */

import type {
  AuthenticatedPrincipal,
  PresenceSystemEvent,
} from "./types.js";

// ---------------------------------------------------------------------------
// Event publisher interface
// ---------------------------------------------------------------------------

/**
 * Callback for publishing events to subscribers.
 */
export type EventPublisher = (
  event: PresenceSystemEvent,
  roomId?: string,
) => void | Promise<void>;

/**
 * Event publisher manager that wraps the publish function with
 * authorization and filtering logic.
 */
export class PresenceEventPublisher {
  private readonly publish: EventPublisher;
  private readonly authorizedSubscribers = new Map<
    string,
    Set<string>
  >(); // subscriberId -> Set<roomId | "*">

  constructor(publish: EventPublisher) {
    this.publish = publish;
  }

  /**
   * Publish a presence user updated event.
   */
  async publishUserUpdated(
    userId: string,
    status: string,
    updatedAt: number,
    roomId?: string,
  ): Promise<void> {
    const event: PresenceSystemEvent = {
      type: "presence.user.updated",
      data: {
        userId,
        status: status as any,
        updatedAt,
      },
    };

    await this.publish(event, roomId);
  }

  /**
   * Publish a presence room updated event.
   */
  async publishRoomUpdated(
    roomId: string,
    members: Array<{ userId: string; status: string }>,
  ): Promise<void> {
    const event: PresenceSystemEvent = {
      type: "presence.room.updated",
      data: {
        roomId,
        members: members as any,
      },
    };

    await this.publish(event, roomId);
  }

  /**
   * Publish an awareness event (typing, cursor).
   * These are ephemeral and should not be persisted.
   */
  async publishAwareness(
    event: Omit<PresenceSystemEvent, "type"> & { type: string },
    roomId: string,
  ): Promise<void> {
    await this.publish(event as PresenceSystemEvent, roomId);
  }

  /**
   * Register a subscriber for events in specific rooms.
   */
  registerSubscriber(subscriberId: string, roomIds: string[]): void {
    const rooms = this.authorizedSubscribers.get(subscriberId) ?? new Set();
    for (const roomId of roomIds) {
      rooms.add(roomId);
    }
    this.authorizedSubscribers.set(subscriberId, rooms);
  }

  /**
   * Unregister a subscriber.
   */
  unregisterSubscriber(subscriberId: string): void {
    this.authorizedSubscribers.delete(subscriberId);
  }

  /**
   * Check if a subscriber is authorized to receive events for a room.
   */
  isSubscriberAuthorized(subscriberId: string, roomId?: string): boolean {
    const rooms = this.authorizedSubscribers.get(subscriberId);
    if (!rooms) {
      return false;
    }

    if (!roomId) {
      return true; // Subscriber receives all events
    }

    return rooms.has(roomId) || rooms.has("*");
  }

  /**
   * Get all subscriber IDs authorized for a room.
   */
  getSubscribersForRoom(roomId: string): string[] {
    const subscribers: string[] = [];

    for (const [subscriberId, rooms] of this.authorizedSubscribers) {
      if (rooms.has(roomId) || rooms.has("*")) {
        subscribers.push(subscriberId);
      }
    }

    return subscribers;
  }
}

/**
 * Creates a simple in-memory event publisher that calls a callback
 * for each subscribed client.
 */
export function createInMemoryEventPublisher(): {
  publish: EventPublisher;
  publisher: PresenceEventPublisher;
  subscribers: Map<string, (event: PresenceSystemEvent) => void>;
} {
  const subscribers = new Map<string, (event: PresenceSystemEvent) => void>();

  const publish: EventPublisher = async (event, roomId) => {
    for (const [subscriberId, callback] of subscribers) {
      // In a real implementation, filter by room authorization
      try {
        callback(event);
      } catch {
        // Subscriber callback failures should not crash publishing
      }
    }
  };

  return {
    publish,
    publisher: new PresenceEventPublisher(publish),
    subscribers,
  };
}
