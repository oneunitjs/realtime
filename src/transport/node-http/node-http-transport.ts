/**
 * Node http WebSocket fallback used when the uWebSockets.js native addon
 * cannot load (older glibc, unsupported ABI). Same TransportConnection
 * contract as the uWS adapter.
 */

import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import type {
  HandshakeContext,
  SendOptions,
  SendResult,
  TransportCloseEvent,
  TransportConnection,
  TransportMessage,
  Unsubscribe,
} from "../../core/connection/connection.types.js";
import type { UwsTransportAdapterOptions } from "../uws/uws-transport.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class NodeWsConnection implements TransportConnection {
  readonly id: string;
  readonly remoteAddress?: string;
  state: "open" | "closing" | "closed" = "open";
  private readonly socket: Socket;
  private readonly handshake: HandshakeContext;
  private readonly messageHandlers = new Set<(message: TransportMessage) => void>();
  private readonly closeHandlers = new Set<(event: TransportCloseEvent) => void>();
  private readonly drainHandlers = new Set<() => void>();
  private closed = false;
  private fragments: Buffer[] = [];
  private binaryFrame = true;
  private buffer = Buffer.alloc(0);

  constructor(id: string, socket: Socket, handshake: HandshakeContext) {
    this.id = id;
    this.socket = socket;
    this.handshake = handshake;
    this.remoteAddress = handshake.remoteAddress;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("close", () => this.handleClose(1006, "socket closed"));
    socket.on("error", () => this.handleClose(1011, "socket error"));
  }

  send(data: Uint8Array, _options?: SendOptions): Promise<SendResult> {
    if (this.closed) {
      return Promise.reject(new Error("Transport connection is closed"));
    }
    this.socket.write(encodeFrame(data, 0x2));
    return Promise.resolve({ status: "accepted", bufferedBytes: 0 });
  }

  async close(code = 1000, reason = ""): Promise<void> {
    if (this.closed) {
      return;
    }
    this.state = "closing";
    const reasonBytes = Buffer.from(reason);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    try {
      this.socket.write(encodeFrame(payload, 0x8));
    } catch {
      // ignore
    }
    this.handleClose(code, reason);
    this.socket.end();
  }

  terminate(): void {
    if (this.closed) {
      return;
    }
    this.handleClose(1006, "terminated");
    this.socket.destroy();
  }

  onMessage(handler: (message: TransportMessage) => void): Unsubscribe {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: (event: TransportCloseEvent) => void): Unsubscribe {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onDrain(handler: () => void): Unsubscribe {
    this.drainHandlers.add(handler);
    return () => this.drainHandlers.delete(handler);
  }

  bufferedBytes(): number {
    return this.socket.writableLength;
  }

  getHandshake(): HandshakeContext {
    return this.handshake;
  }

  ingest(chunk: Buffer): void {
    this.onData(chunk);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const parsed = decodeFrame(this.buffer);
      if (!parsed) {
        return;
      }
      this.buffer = Buffer.from(parsed.rest);
      if (parsed.opcode === 0x8) {
        void this.close(1000, "peer close");
        return;
      }
      if (parsed.opcode === 0x9) {
        this.socket.write(encodeFrame(parsed.payload, 0xa));
        continue;
      }
      if (parsed.opcode === 0xa) {
        continue;
      }
      if (parsed.opcode === 0x1 || parsed.opcode === 0x2) {
        this.fragments = [parsed.payload];
        this.binaryFrame = parsed.opcode === 0x2;
      } else {
        this.fragments.push(parsed.payload);
      }
      if (parsed.fin) {
        const data = Buffer.concat(this.fragments);
        this.fragments = [];
        const message: TransportMessage = {
          data: new Uint8Array(data),
          isBinary: this.binaryFrame,
        };
        for (const handler of this.messageHandlers) {
          try {
            handler(message);
          } catch {
            // isolated
          }
        }
      }
    }
  }

  private handleClose(code: number, reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.state = "closed";
    for (const handler of this.closeHandlers) {
      try {
        handler({ code, reason, wasClean: code === 1000 });
      } catch {
        // isolated
      }
    }
  }
}

export class NodeHttpTransportAdapter {
  private server: HttpServer | null = null;
  private listening = false;
  private readonly options: UwsTransportAdapterOptions;
  private readonly connections = new Map<string, NodeWsConnection>();

  constructor(options: UwsTransportAdapterOptions) {
    this.options = options;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  get droppedMessageCount(): number {
    return 0;
  }

  get isListening(): boolean {
    return this.listening;
  }

  async listen(port: number, host = "0.0.0.0"): Promise<void> {
    if (this.listening) {
      return;
    }
    this.server = createServer((req, res) => {
      if (this.options.httpHandler) {
        this.options.httpHandler(req, res);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    this.server.on("upgrade", (req, socket, head) => {
      this.onUpgrade(req, socket as Socket, head);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => {
        this.listening = true;
        resolve();
      });
    });
  }

  mount(_app: unknown): void {
    throw new Error("Node HTTP fallback does not mount on a uWS App");
  }

  async close(): Promise<void> {
    for (const conn of this.connections.values()) {
      conn.terminate();
    }
    this.connections.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    this.listening = false;
  }

  async sendTo(id: string, data: Uint8Array): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) {
      throw new Error(`Connection ${id} not found`);
    }
    await conn.send(data);
  }

  async closeConnection(id: string, code?: number, reason?: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) {
      throw new Error(`Connection ${id} not found`);
    }
    await conn.close(code, reason);
  }

  getConnection(id: string): NodeWsConnection | undefined {
    return this.connections.get(id);
  }

  private onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== this.options.path) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const allowed = this.options.allowedOrigins;
    if (allowed && allowed.length > 0 && (!origin || !allowed.includes(origin))) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        headers[name] = value;
      }
    }
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, name) => {
      query[name] = value;
    });
    const handshake: HandshakeContext = {
      path: this.options.path,
      headers,
      origin,
      remoteAddress: socket.remoteAddress,
      query,
      protocol:
        typeof req.headers["sec-websocket-protocol"] === "string"
          ? req.headers["sec-websocket-protocol"]
          : undefined,
      signal: new AbortController().signal,
    };
    const id = `node_${crypto.randomUUID()}`;
    const conn = new NodeWsConnection(id, socket, handshake);
    this.connections.set(id, conn);
    conn.onClose(() => this.connections.delete(id));
    if (head.length > 0) {
      conn.ingest(head);
    }
    this.options.onConnection?.(conn, handshake);
  }
}

function encodeFrame(data: Uint8Array, opcode: number): Buffer {
  const payload = Buffer.from(data);
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrame(
  buffer: Buffer,
): { fin: boolean; opcode: number; payload: Buffer; rest: Buffer } | null {
  if (buffer.length < 2) {
    return null;
  }
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) {
      return null;
    }
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) {
      return null;
    }
    length = buffer.readUInt32BE(6);
    offset = 10;
  }
  const maskOffset = offset;
  if (masked) {
    offset += 4;
  }
  if (buffer.length < offset + length) {
    return null;
  }
  let payload = buffer.subarray(offset, offset + length);
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    const copy = Buffer.from(payload);
    for (let i = 0; i < copy.length; i++) {
      copy[i] ^= mask[i % 4];
    }
    payload = copy;
  }
  return { fin, opcode, payload, rest: Buffer.from(buffer.subarray(offset + length)) };
}
