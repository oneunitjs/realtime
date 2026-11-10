/**
 * Client-side channel for `@oneunit/realtime/client`.
 */

import { encodeFrame } from "../protocol/index.js";
import type { Codec, CodecName } from "../protocol/types.js";
import type { WebSocketTransport } from "./transport.js";
import type { Unsubscribe } from "../core/connection/connection.types.js";

export type ClientMessageHandler<TMessage = unknown> = (
  message: TMessage,
) => void | Promise<void>;

export type ClientPresenceHandler = (
  event: { type: "joined" | "left"; name: string; room?: string },
) => void | Promise<void>;

export type ClientUnsubscribe = Unsubscribe;

export class RealtimeClientChannel<TMessage = unknown> {
  readonly name: string;
  private transport: WebSocketTransport | null;
  private readonly codec: Codec;
  private readonly codecName: CodecName;
  private readonly messageHandlers = new Set<ClientMessageHandler<unknown>>();
  private readonly presenceHandlers = new Set<ClientPresenceHandler>();
  private joined = false;

  constructor(
    name: string,
    transport: WebSocketTransport | null,
    codec: Codec,
    codecName: CodecName,
  ) {
    this.name = name;
    this.transport = transport;
    this.codec = codec;
    this.codecName = codecName;
  }

  attach(transport: WebSocketTransport | null): void {
    this.transport = transport;
  }

  async join(): Promise<void> {
    this.write({ type: "join", channel: this.name });
    this.joined = true;
  }

  async leave(): Promise<void> {
    if (!this.joined) {
      return;
    }
    this.write({ type: "leave", channel: this.name });
    this.joined = false;
  }

  async send(message: TMessage): Promise<void> {
    this.write({
      type: "message",
      channel: this.name,
      payload: message,
    });
  }

  on(event: "message", handler: ClientMessageHandler<TMessage>): ClientUnsubscribe;
  on(event: "presence", handler: ClientPresenceHandler): ClientUnsubscribe;
  on(
    event: "message" | "presence",
    handler: ClientMessageHandler<TMessage> | ClientPresenceHandler,
  ): ClientUnsubscribe {
    if (event === "message") {
      this.messageHandlers.add(handler as ClientMessageHandler<unknown>);
      return (): void => {
        this.messageHandlers.delete(handler as ClientMessageHandler<unknown>);
      };
    }

    this.presenceHandlers.add(handler as ClientPresenceHandler);
    return (): void => {
      this.presenceHandlers.delete(handler as ClientPresenceHandler);
    };
  }

  isJoined(): boolean {
    return this.joined;
  }

  receive(message: unknown): void {
    const frame = message as {
      type?: string;
      channel?: string;
      payload?: unknown;
      name?: string;
      event?: string;
      room?: string;
    };

    if (frame.type === "message" && frame.channel === this.name) {
      const payload = frame.payload ?? message;
      for (const handler of [...this.messageHandlers]) {
        const result = handler(payload as TMessage);
        if (result && typeof (result as Promise<unknown>).catch === "function") {
          void (result as Promise<unknown>).catch(() => {});
        }
      }
      return;
    }

    if (
      (frame.type === "presence" || frame.type === "joined" || frame.type === "left") &&
      frame.channel === this.name
    ) {
      const presenceEvent = {
        type: (frame.type === "left" ? "left" : "joined") as "joined" | "left",
        name: (frame as { name?: string }).name ?? "",
        room: frame.room ?? this.name,
      };
      for (const handler of [...this.presenceHandlers]) {
        const result = handler(presenceEvent);
        if (result && typeof (result as Promise<unknown>).catch === "function") {
          void (result as Promise<unknown>).catch(() => {});
        }
      }
    }
  }

  close(): void {
    this.joined = false;
  }

  private write(envelope: { type: string; channel?: string; payload?: unknown }): void {
    if (!this.transport) {
      throw new Error("Client is not connected");
    }
    this.transport.send(
      encodeFrame(
        {
          protocolVersion: 1,
          type: envelope.type,
          channel: envelope.channel,
          payload: envelope.payload,
        },
        { codec: this.codecName },
      ),
    );
  }
}
