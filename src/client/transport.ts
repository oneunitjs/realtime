/**
 * Client-side WebSocket transport for `@oneunit/realtime/client`.
 *
 * Browser-safe: imports only `node:crypto`-free WebSocket APIs available in
 * both Node.js and modern browsers. It normalizes the transport ready state
 * and sends/receives protocol frames as raw `Uint8Array` payloads.
 */

export interface WebSocketTransportOptions {
  url: string;
  protocols?: string | string[];
}

/** Minimal normalized WebSocket surface used by the client SDK. */
export interface WebSocketTransport {
  readonly url: string;
  readonly readyState: number;
  readonly OPEN: number;
  readonly CLOSING: number;
  readonly CLOSED: number;
  binaryType: "arraybuffer" | "blob";
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

/** Create a transport from the global WebSocket. */
export function createWebSocketTransport(
  options: WebSocketTransportOptions,
): WebSocketTransport {
  const ws = new WebSocket(options.url, options.protocols);
  ws.binaryType = "arraybuffer";
  return {
    url: ws.url,
    readyState: ws.readyState,
    OPEN: WebSocket.OPEN,
    CLOSING: WebSocket.CLOSING,
    CLOSED: WebSocket.CLOSED,
    get binaryType() {
      return ws.binaryType;
    },
    set binaryType(value) {
      ws.binaryType = value;
    },
    addEventListener: (type, listener) => ws.addEventListener(type, listener),
    removeEventListener: (type, listener) => ws.removeEventListener(type, listener),
    send: (data) => ws.send(data),
    close: (code?, reason?) => ws.close(code, reason),
  };
}
