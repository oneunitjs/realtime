/**
 * RGA text sequence.
 *
 * Implements docs/collab/collaboration-engine.md §6 and
 * docs/collab/collaboration-engine-architecture-plan.md §5.4.
 *
 * Replicated Growable Array with stable element IDs, deterministic sibling
 * ordering, and tombstones.
 *
 * v1 value model: `value` is a single Unicode scalar (one code point).
 *
 * Insert:
 *   1. Validate op and causal deps.
 *   2. Confirm anchor exists (or buffer).
 *   3. Add node with stable ID + anchor.
 *   4. Order concurrent children of same anchor by (actorId, counter).
 *   5. Update local version vector.
 * Delete:
 *   1. Validate deps and target identity.
 *   2. Mark target deleted (tombstone); preserve node.
 *   3. Always traverse descendants during render (tombstoned parents don't
 *      orphan children).
 * Render:
 *   Traverse from ROOT in stable (actorId, counter) order; append value only
 *   when not deleted; always recurse into descendants.
 */

import type {
  CrdtOperation,
  ElementId,
  RgaNode,
  TextDeleteOperation,
  TextInsertOperation,
  VectorClock,
} from "./types.js";
import {
  CORE_LIMITS,
  compareElementId,
  elementIdEquals,
  encodeElementId,
} from "./types.js";
import { depsSatisfied, validateVectorClock } from "./vector-clock.js";

export class RgaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Validates an insert operation's shape and size limits. */
function validateInsert(op: TextInsertOperation): void {
  const points = Array.from(op.value);
  if (
    points.length !== 1 ||
    op.value.codePointAt(0) === undefined
  ) {
    throw new RgaError("RGA insert value must be exactly one Unicode scalar");
  }
  const codePoint = op.value.codePointAt(0)!;
  if (
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    codePoint > 0x10ffff
  ) {
    throw new RgaError("RGA insert value must not be a surrogate or invalid");
  }
  if (op.value.length > CORE_LIMITS.maxStringLength) {
    throw new RgaError("RGA insert value exceeds max string length");
  }
}

export interface RgaOptions {
  maxPendingOps?: number;
}

export class RgaSequence {
  private nodes = new Map<string, RgaNode>();
  /** children[anchorKey] = sorted ElementId[] where anchorKey is encodeElementId(id) or "ROOT" */
  private children = new Map<string, ElementId[]>();
  private versionVector: VectorClock = {};
  private readonly maxPendingOps: number;

  constructor(options: RgaOptions = {}) {
    this.maxPendingOps = options.maxPendingOps ?? CORE_LIMITS.maxPendingOps;
  }

  /** Snapshot of the current version vector. */
  getVectorClock(): VectorClock {
    return { ...this.versionVector };
  }

  /** Number of known nodes (including tombstones). */
  size(): number {
    return this.nodes.size;
  }

  /** Rendered text: traverse from ROOT in stable order, skip deleted values,
   *  always recurse into descendants. */
  render(): string {
    const out: string[] = [];
    this.renderAnchor("ROOT", out);
    return out.join("");
  }

  /** Visible (non-tombstoned) element IDs in render order. */
  visibleIds(): ElementId[] {
    const out: ElementId[] = [];
    this.collectVisible("ROOT", out);
    return out;
  }

  private collectVisible(anchor: ElementId | "ROOT", out: ElementId[]): void {
    const children = this.childrenOf(anchor);
    for (const child of children) {
      const node = this.nodes.get(encodeElementId(child));
      if (!node) {
        continue;
      }
      if (!node.deleted) {
        out.push(child);
      }
      this.collectVisible(child, out);
    }
  }

  private renderAnchor(anchor: ElementId | "ROOT", out: string[]): void {
    const children = this.childrenOf(anchor);
    for (const child of children) {
      const node = this.nodes.get(encodeElementId(child));
      if (!node) {
        continue; // dangling reference; skip defensively
      }
      if (!node.deleted) {
        out.push(node.value);
      }
      // Always traverse descendants, even when parent is tombstoned.
      this.renderAnchor(child, out);
    }
  }

  /** Apply an insert operation. Returns the rendered text after applying. */
  insert(op: TextInsertOperation): string {
    validateInsert(op);
    if (!depsSatisfied(this.versionVector, op.deps)) {
      throw new RgaError(
        `Insert op ${encodeElementId(op.opId)} dependencies not satisfied`,
      );
    }
    // Idempotency: duplicate opId with same payload is a no-op.
    const existing = this.nodes.get(encodeElementId(op.opId));
    if (existing) {
      return this.render();
    }

    // Anchor must exist (or be ROOT).
    if (op.after !== "ROOT") {
      const anchorKey = encodeElementId(op.after);
      if (!this.nodes.has(anchorKey)) {
        throw new RgaError(
          `Insert anchor ${encodeElementId(op.after)} not yet known`,
        );
      }
    }

    const node: RgaNode = {
      id: op.opId,
      after: op.after,
      value: op.value,
      deleted: false,
    };
    this.nodes.set(encodeElementId(op.opId), node);
    this.addChild(op.after, op.opId);

    // Advance version vector for this actor up to this op's counter.
    const current = this.versionVector[op.opId.actorId] ?? 0;
    if (op.opId.counter > current) {
      this.versionVector[op.opId.actorId] = op.opId.counter;
    }

    return this.render();
  }

  /** Apply a delete operation. Returns the rendered text after applying. */
  delete(op: TextDeleteOperation): string {
    if (!depsSatisfied(this.versionVector, op.deps)) {
      throw new RgaError(
        `Delete op ${encodeElementId(op.opId)} dependencies not satisfied`,
      );
    }
    // Idempotency.
    const existing = this.nodes.get(encodeElementId(op.opId));
    if (existing) {
      if (!existing.deleted) {
        existing.deleted = true;
        const current = this.versionVector[op.opId.actorId] ?? 0;
        if (op.opId.counter > current) {
          this.versionVector[op.opId.actorId] = op.opId.counter;
        }
      }
      return this.render();
    }

    const target = this.nodes.get(encodeElementId(op.target));
    if (!target) {
      // Target not yet arrived: buffer or reject as causally incomplete;
      // never silently drop the delete.
      throw new RgaError(
        `Delete target ${encodeElementId(op.target)} not yet known`,
      );
    }

    target.deleted = true;
    const current = this.versionVector[op.opId.actorId] ?? 0;
    if (op.opId.counter > current) {
      this.versionVector[op.opId.actorId] = op.opId.counter;
    }
    return this.render();
  }

  /** Apply a generic text op (insert or delete). */
  apply(op: unknown): string {
    const o = op as import("./types.js").CrdtOperation;
    if (o.kind === "text.insert") {
      return this.insert(o as import("./types.js").TextInsertOperation);
    }
    if (o.kind === "text.delete") {
      return this.delete(o as import("./types.js").TextDeleteOperation);
    }
    throw new RgaError(`Unsupported RGA op kind: ${o.kind}`);
  }

  /** Nodes currently known (values only, tombstones included). */
  getNodes(): RgaNode[] {
    return [...this.nodes.values()];
  }

  /**
   * Bulk-load nodes into the sequence (used to restore a snapshot).
   * Nodes are inserted without re-validating causal deps; the caller is
   * responsible for snapshot integrity. The derived children cache is cleared
   * so it recomputes from the loaded node set.
   */
  loadNodes(nodes: readonly RgaNode[]): void {
    const nextNodes = new Map<string, RgaNode>();
    const nextChildren = new Map<string, ElementId[]>();
    nextChildren.set("ROOT", []);

    for (const node of nodes) {
      const key = encodeElementId(node.id);
      if (nextNodes.has(key)) {
        throw new RgaError("Duplicate snapshot node");
      }
      nextNodes.set(key, { ...node });
    }

    // Rebuild child indexes from the loaded nodes. An anchor must either be
    // "ROOT" or reference another loaded node.
    for (const node of nextNodes.values()) {
      const anchorKey =
        node.after === "ROOT" ? "ROOT" : encodeElementId(node.after);
      if (
        anchorKey !== "ROOT" &&
        !nextNodes.has(anchorKey)
      ) {
        throw new RgaError("Missing snapshot anchor");
      }
      const kids = nextChildren.get(anchorKey) ?? [];
      kids.push(node.id);
      nextChildren.set(anchorKey, kids);
    }

    // Reject cycles: every node must be reachable from ROOT without revisiting.
    const visited = new Set<string>();
    const stack: Array<ElementId | "ROOT"> = ["ROOT"];
    while (stack.length > 0) {
      const anchor = stack.pop()!;
      const key = anchor === "ROOT" ? "ROOT" : encodeElementId(anchor);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      for (const child of nextChildren.get(key) ?? []) {
        stack.push(child);
      }
    }
    for (const key of nextNodes.keys()) {
      if (!visited.has(key)) {
        throw new RgaError("Snapshot contains a cycle or unreachable node");
      }
    }

    for (const kids of nextChildren.values()) {
      kids.sort((a, b) => compareElementId(a, b));
    }

    this.nodes = nextNodes;
    this.children = nextChildren;

    // Rebuild the version vector from the loaded nodes.
    this.versionVector = {};
    for (const node of nextNodes.values()) {
      const current = this.versionVector[node.id.actorId] ?? 0;
      if (node.id.counter > current) {
        this.versionVector[node.id.actorId] = node.id.counter;
      }
    }
  }

  private childrenOf(anchor: ElementId | "ROOT"): ElementId[] {
    const key = anchor === "ROOT" ? "ROOT" : encodeElementId(anchor);
    const cached = this.children.get(key);
    if (cached) {
      return cached;
    }
    // Compute children of this anchor from all nodes.
    const kids: ElementId[] = [];
    for (const node of this.nodes.values()) {
      if (
        (anchor === "ROOT" && node.after === "ROOT") ||
        (anchor !== "ROOT" &&
          node.after !== "ROOT" &&
          elementIdEquals(node.after, anchor))
      ) {
        kids.push(node.id);
      }
    }
    kids.sort((a, b) => compareElementId(a, b));
    this.children.set(key, kids);
    return kids;
  }

  private addChild(anchor: ElementId | "ROOT", childId: ElementId): void {
    const key = anchor === "ROOT" ? "ROOT" : encodeElementId(anchor);
    const kids = this.children.get(key);
    if (kids) {
      // Insert in sorted order.
      let i = 0;
      while (i < kids.length && compareElementId(kids[i], childId) < 0) {
        i += 1;
      }
      kids.splice(i, 0, childId);
    } else {
      this.children.set(key, [childId]);
    }
  }
}
