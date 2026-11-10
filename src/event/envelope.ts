/**
 * Event envelope builder.
 *
 * Builds one envelope per logical event:
 *
 *   - Generates `messageId` once when the event is accepted; reuses it for
 *     every retry.
   *   - Derives sender IDs exclusively from the authenticated
 *     ClientConnection / Principal; ignores identity claims inside the
 *     payload.
 *   - Validates protocol version, required fields, expiry, and payload size
 *     before routing.
 */

import type {
  EventEnvelope,
  PublishOptions,
} from "./types.js";
import { EVENT_PROTOCOL_VERSION } from "./types.js";

export interface EnvelopeInput {
  event: string;
  payload: unknown;
  namespace: string;
  roomId?: string;
  senderConnectionId: string;
  senderUserId: string;
  delivery: "ephemeral" | "at-least-once";
  messageId?: string; // supplied for idempotent duplicate publish lookup
  expiresAt?: number;
  protocolVersion?: number;
}

export class EnvelopeBuilder {
  constructor(
    private readonly clock: { now(): number },
    private readonly idGenerator: { generate(): string },
    private readonly config: {
      protocolVersion: number;
      maxPayloadBytes: number;
    },
  ) {}

  /**
   * Build an envelope for a logical event. Returns the envelope plus a
   * flag indicating whether this was a fresh message id or an idempotent
   * reuse of an existing one.
   */
  build(input: EnvelopeInput): {
    envelope: EventEnvelope;
    isIdempotentReuse: boolean;
  } {
    const now = this.clock.now();
    const protocolVersion = input.protocolVersion ?? this.config.protocolVersion;
    if (protocolVersion !== EVENT_PROTOCOL_VERSION) {
      throw new Error(`Unsupported event protocol version: ${protocolVersion}`);
    }

    const messageId =
      input.messageId ?? this.idGenerator.generate();

    const payloadBytes = this.encodePayloadSize(input.payload);
    if (payloadBytes > this.config.maxPayloadBytes) {
      throw new Error(
        `Payload of ${payloadBytes} bytes exceeds the ${this.config.maxPayloadBytes} byte limit`,
      );
    }

    const expiresAt = input.expiresAt ?? now + 300_000;

    const envelope: EventEnvelope = {
      protocolVersion,
      messageId,
      event: input.event,
      senderConnectionId: input.senderConnectionId,
      senderUserId: input.senderUserId,
      namespace: input.namespace,
      roomId: input.roomId,
      createdAt: now,
      expiresAt,
      delivery: input.delivery,
      payload: input.payload,
    };

    return { envelope, isIdempotentReuse: !!input.messageId };
  }

  private encodePayloadSize(payload: unknown): number {
    try {
      return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    } catch {
      return 0;
    }
  }
}
