/**
 * Collaboration document sync integration tests.
 *
 * Verifies CRDT op publish through the Hub, decode + apply convergence on
 * subscribers, concurrent replica convergence, and write-permission
 * rejection.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hub } from "../../../src/core/core-hub.js";
import { FakeTransport } from "../../../src/transport/testing/transport-connection.js";
import type {
  CrdtOperation,
  ElementId,
  TextInsertOperation,
  VectorClock,
} from "../../../src/collab/core/types.js";
import { ApplyEngine } from "../../../src/collab/core/apply.js";
import { encodeOperation, validateOperation, validateSchemaVersion } from "../../../src/collab/core/encode.js";
import { decodeElementId } from "../../../src/collab/core/types.js";
import { createTestHub, connectClient } from "../helpers/hub-factory.js";

function makeOp(opts: {
  actorId: string;
  counter: number;
  after: ElementId | "ROOT";
  value: string;
  deps?: VectorClock;
}): TextInsertOperation {
  return {
    kind: "text.insert",
    opId: { actorId: opts.actorId, counter: opts.counter },
    deps: opts.deps ?? {},
    after: opts.after,
    value: opts.value,
  };
}

async function publishOp(hub: Hub, connectionId: string, documentId: string, op: CrdtOperation) {
  validateOperation(op);
  validateSchemaVersion(1);
  const encoded = encodeOperation(op);
  return hub.publish(connectionId, {
    type: "collab:op",
    documentId,
    payload: { op: Array.from(encoded) },
    excludeSender: true,
  } as never);
}

function decodeOpFromFrame(frame: { data: Uint8Array }): CrdtOperation {
  const decoded = JSON.parse(new TextDecoder().decode(frame.data));
  const bobEncoded = new Uint8Array(decoded.payload.op as number[]);
  const opJson = JSON.parse(new TextDecoder().decode(bobEncoded));
  return {
    kind: opJson.kind as "text.insert",
    opId: decodeElementId(opJson.opId as string),
    deps: opJson.deps as VectorClock,
    after: opJson.after === "ROOT" ? "ROOT" : decodeElementId(opJson.after as string),
    value: opJson.value as string,
  } as CrdtOperation;
}

function findOpByActor(frames: unknown[], actorId: string): CrdtOperation {
  for (const frame of frames as Array<{ data: Uint8Array }>) {
    const op = decodeOpFromFrame(frame);
    if ((op as TextInsertOperation).opId.actorId === actorId) {
      return op;
    }
  }
  throw new Error(`no op from actor ${actorId} found in frames`);
}

describe("collaboration document sync", () => {
  let hub: Hub;
  let alice: FakeTransport;
  let bob: FakeTransport;
  let aliceFrames: unknown[];
  let bobFrames: unknown[];

  beforeEach(async () => {
    hub = createTestHub();
    alice = await connectClient(hub, "c-alice", "cred-alice");
    bob = await connectClient(hub, "c-bob", "cred-bob");
    aliceFrames = [];
    bobFrames = [];
    alice.onSend((message) => aliceFrames.push(message));
    bob.onSend((message) => bobFrames.push(message));

    await hub.subscribeDocument("c-alice", "doc-1", "write");
    await hub.subscribeDocument("c-bob", "doc-1", "write");
  });

  afterEach(() => {
    hub.close();
  });

  it("routes an insert op through Hub document publish to a subscriber", async () => {
    const bobEngine = new ApplyEngine();
    const op = makeOp({ actorId: "alice", counter: 1, after: "ROOT", value: "h" });

    const result = await publishOp(hub, "c-alice", "doc-1", op);
    expect(result.status).toBe("delivered");
    if (result.status === "delivered") {
      expect(result.recipientCount).toBe(1);
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bobFrames.length).toBe(1);

    const bobOp = decodeOpFromFrame(bobFrames[0] as { data: Uint8Array });
    validateOperation(bobOp);
    const applyResult = bobEngine.apply(bobOp);
    expect(applyResult.status).toBe("applied");
    expect(bobEngine.getState().text).toBe("h");
  });

  it("rejects publishing to a document without write subscription", async () => {
    await connectClient(hub, "c-charlie", "cred-charlie");
    const op = makeOp({ actorId: "charlie", counter: 1, after: "ROOT", value: "x" });

    const result = await publishOp(hub, "c-charlie", "doc-1", op);
    expect(result.status).toBe("rejected");

    hub.disconnect("c-charlie", "test cleanup");
  });

  it("concurrent inserts from two replicas converge to identical text", async () => {
    const aliceEngine = new ApplyEngine();
    const bobEngine = new ApplyEngine();

    const opA = makeOp({ actorId: "alice", counter: 1, after: "ROOT", value: "a" });
    const opB = makeOp({ actorId: "bob", counter: 1, after: "ROOT", value: "b" });

    await publishOp(hub, "c-alice", "doc-1", opA);
    await publishOp(hub, "c-bob", "doc-1", opB);

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Alice applies her own op then Bob's op; Bob applies his own then Alice's.
    aliceEngine.apply(opA);
    aliceEngine.apply(findOpByActor(aliceFrames, "bob"));

    bobEngine.apply(opB);
    bobEngine.apply(findOpByActor(bobFrames, "alice"));

    expect(aliceEngine.getState().text).toBe(bobEngine.getState().text);
  });
});
