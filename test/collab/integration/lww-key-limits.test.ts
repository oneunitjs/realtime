/**
 * Integration: LWW map key limits. `set`/`delete` enforce `maxKeys`; tombstones
 * count toward the limit; overflow throws `LwwMapError`.
 */

import { describe, it, expect } from "vitest";
import { LwwMap, LwwMapError } from "../../../src/collab/core/map-lww.js";
import type { CrdtOperation } from "../../../src/collab/core/types.js";
import { makeMapDeleteOp, makeMapSetOp } from "../../helpers/collab.js";

function setOp(key: string, value: unknown, logicalTime = 1): CrdtOperation {
  return makeMapSetOp({ actorId: "a", counter: 1, key, value, logicalTime });
}
function deleteOp(key: string, logicalTime = 1): CrdtOperation {
  return makeMapDeleteOp({ actorId: "a", counter: 1, key, logicalTime });
}

describe("collab integration — LWW key limits", () => {
  it("set enforces maxKeys; existing-key overwrites do not consume a slot", () => {
    const map = new LwwMap({ maxKeys: 2 });
    map.set(setOp("k1", "v1"));
    map.set(setOp("k2", "v2"));
    expect(map.get("k1")).toBe("v1");
    expect(map.get("k2")).toBe("v2");

    // Overwriting an existing key does not consume a new slot.
    map.set(setOp("k1", "v1-updated", 2));
    expect(map.get("k1")).toBe("v1-updated");
    expect(map.getMap().size).toBe(2);

    // A new key beyond maxKeys throws.
    expect(() => map.set(setOp("k3", "v3"))).toThrow(LwwMapError);
    expect(() => map.set(setOp("k3", "v3"))).toThrow("Maximum map keys exceeded");
  });

  it("delete stores a tombstone that counts toward maxKeys", () => {
    const map = new LwwMap({ maxKeys: 2 });
    map.set(setOp("k1", "v1"));
    map.delete(deleteOp("k2", 1)); // tombstone for a new key consumes a slot
    expect(map.has("k1")).toBe(true);
    expect(map.has("k2")).toBe(false);
    // The tombstone for k2 still occupies a key slot.
    expect(map.size()).toBe(2);

    // A third distinct key exceeds the limit even though one is a tombstone.
    expect(() => map.set(setOp("k3", "v3"))).toThrow(LwwMapError);
  });

  it("overflow throws on set and delete of a new key", () => {
    const map = new LwwMap({ maxKeys: 1 });
    map.set(setOp("only", "v"));

    expect(() => map.set(setOp("extra", "v"))).toThrow(LwwMapError);
    expect(() => map.delete(deleteOp("extra2", 1))).toThrow(LwwMapError);
  });
});
