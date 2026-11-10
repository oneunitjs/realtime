/**
 * Canonical Room Key Encoding
 *
 * Derives a single canonical roomKey from (tenantId, namespaceId, roomId)
 * using an unambiguous length-prefixed encoding that cannot collide.
 *
 * A channel prefix is NOT a security boundary — authorization and tenant
 * checks remain mandatory regardless of encoding.
 */

const FIELD_SEPARATOR = "\u001F"; // Unit Separator (ASCII 31)

/**
 * Encode a canonical room key from tenantId, namespaceId, roomId.
 *
 * Uses length-prefixed fields so that component boundaries are unambiguous
 * even if component values contain the separator character.
 *
 * Format: <len(tenantId)>:\u001F<tenantId>\u001F<len(namespaceId)>:\u001F<namespaceId>\u001F<len(roomId)>:\u001F<roomId>
 */
export function encodeRoomKey(
  tenantId: string,
  namespaceId: string,
  roomId: string,
): string {
  const parts = [tenantId, namespaceId, roomId];
  const encoded: string[] = [];

  for (const part of parts) {
    encoded.push(String(part.length), FIELD_SEPARATOR, part, FIELD_SEPARATOR);
  }

  return encoded.join("");
}

/**
 * Decode a canonical room key back into its components.
 *
 * Returns null if the key is malformed.
 */
export function decodeRoomKey(roomKey: string): {
  tenantId: string;
  namespaceId: string;
  roomId: string;
} | null {
  let offset = 0;

  const readField = (): string | null => {
    // Read length until separator
    let lenStr = "";
    while (offset < roomKey.length && roomKey[offset] !== FIELD_SEPARATOR) {
      lenStr += roomKey[offset];
      offset++;
    }

    if (offset >= roomKey.length) {
      return null;
    }

    offset++; // skip separator

    const len = parseInt(lenStr, 10);
    if (isNaN(len) || len < 0) {
      return null;
    }

    if (offset + len > roomKey.length) {
      return null;
    }

    const field = roomKey.slice(offset, offset + len);
    offset += len;

    // Expect trailing separator
    if (offset < roomKey.length && roomKey[offset] === FIELD_SEPARATOR) {
      offset++;
    }

    return field;
  };

  const tenantId = readField();
  const namespaceId = readField();
  const roomId = readField();

  if (tenantId === null || namespaceId === null || roomId === null) {
    return null;
  }

  // Verify we consumed the entire key
  if (offset !== roomKey.length) {
    return null;
  }

  return { tenantId, namespaceId, roomId };
}

/**
 * Validate that a room key is well-formed.
 */
export function isValidRoomKey(roomKey: string): boolean {
  return decodeRoomKey(roomKey) !== null;
}

/**
 * Build a namespace key from (tenantId, namespaceId).
 */
export function encodeNamespaceKey(
  tenantId: string,
  namespaceId: string,
): string {
  return `${String(tenantId.length)}:${FIELD_SEPARATOR}${tenantId}${FIELD_SEPARATOR}${String(namespaceId.length)}:${FIELD_SEPARATOR}${namespaceId}`;
}

/**
 * Parse a namespace key.
 */
export function decodeNamespaceKey(namespaceKey: string): {
  tenantId: string;
  namespaceId: string;
} | null {
  let offset = 0;

  const readField = (): string | null => {
    let lenStr = "";
    while (offset < namespaceKey.length && namespaceKey[offset] !== FIELD_SEPARATOR) {
      lenStr += namespaceKey[offset];
      offset++;
    }

    if (offset >= namespaceKey.length) {
      return null;
    }

    offset++; // skip separator

    const len = parseInt(lenStr, 10);
    if (isNaN(len) || len < 0) {
      return null;
    }

    if (offset + len > namespaceKey.length) {
      return null;
    }

    const field = namespaceKey.slice(offset, offset + len);
    offset += len;

    if (offset < namespaceKey.length && namespaceKey[offset] === FIELD_SEPARATOR) {
      offset++;
    }

    return field;
  };

  const tenantId = readField();
  const namespaceId = readField();

  if (tenantId === null || namespaceId === null) {
    return null;
  }

  if (offset !== namespaceKey.length) {
    return null;
  }

  return { tenantId, namespaceId };
}
