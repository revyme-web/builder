// slot-children.ts — serialize canvas nodes connected into a code-component
// slot, and rebuild them as React "ghost" children inside the sandbox.
//
// On the live site `<LensBox>{node}</LensBox>` is plain React — the child
// renders natively. On the CANVAS, code components mount in isolation
// (sandbox-code-host), so the connected canvas node won't appear inside
// unless we hand it in. We serialize the connected subtree (parent side),
// ship it as a `__slotChildren` prop, and rebuild it as React elements
// inside the sandbox — a non-interactive ghost preview kept in sync via the
// props hash. The real, editable copy still floats on the canvas.

import React from 'react';
import type { CanvasNode } from '@/code/parsing/parser';
import { jsxStyleToHTML } from '@/shared/css-utils';

/** A JSON-serializable snapshot of a connected canvas-node subtree. */
export interface SerializedSlotNode {
  type: string;
  styles: Record<string, string>;
  attrs: Record<string, string>;
  textContent?: string;
  /** RICH TEXT: `textContent` is raw inner JSX (`<span style={{…}}>hi</span>`),
   *  not plain text. The ghost must render it as MARKUP — handed to React as a
   *  text child it painted the source verbatim on the canvas (user report
   *  2026-07-26). Mirrors the Renderer's `shouldUseInnerHTML` branch. */
  hasMixedContent?: boolean;
  children: SerializedSlotNode[];
}

/** IDs of every node ABOVE `nodeId` in the tree (parent, grandparent, …).
 *  Cycle-safe: stops if a parent chain loops back on itself. */
export function collectAncestorIds(nodes: Map<string, CanvasNode>, nodeId: string): Set<string> {
  const out = new Set<string>();
  for (let a = nodes.get(nodeId)?.parentId ?? null; a && !out.has(a); a = nodes.get(a)?.parentId ?? null) {
    out.add(a);
  }
  return out;
}

/** Whether a canvas node is a valid drop target for a code component's slot
 *  connection. Rejects: non-canvas / nested nodes, the component itself, any of
 *  its ANCESTORS (wiring the slot to a container makes the component render its
 *  own parent — a cycle: Frame → component → Frame …), and — for a multi-slot —
 *  a node already connected to this component. */
export function isEligibleSlotTarget(
  node: CanvasNode | undefined,
  opts: { componentId: string; ancestorIds: Set<string>; connectedIds: string[]; isSingleSlot: boolean },
): boolean {
  if (!node || !node.isCanvasNode || node.parentId || node.id === opts.componentId) return false;
  if (opts.ancestorIds.has(node.id)) return false;
  if (!opts.isSingleSlot && opts.connectedIds.includes(node.id)) return false;
  return true;
}

/** Serialize one node + its subtree.
 *
 * `slotConnections` (optional) — file-level map of `componentId → connectedCanvasNodeIds`
 * from `getAllSlotConnections(code)`. When a serialized node IS itself a
 * slot-bearing component (e.g. a `<Marquee>` that lives as a `data-canvas-node`
 * and was wired into another Marquee), its real "children" come from this
 * map, NOT from `n.children` (inline JSX). Without merging them in, nested
 * slot-bearing canvas nodes ghost as empty shells on the canvas — even
 * though they render correctly on the live site (where the `{cn_X}` JSX
 * references resolve at React render).
 *
 * `visited` — guards against pathological cycles in the slot graph (cn_A
 * inside cn_B inside cn_A). Cycles would also infinite-render at runtime
 * but we shouldn't crash serialization either.
 */
function serializeSlotNode(
  id: string,
  nodes: Map<string, CanvasNode>,
  slotConnections?: Map<string, string[]>,
  visited: Set<string> = new Set(),
): SerializedSlotNode | null {
  const n = nodes.get(id);
  if (!n) return null;
  if (visited.has(id)) return null;
  visited.add(id);

  const inlineChildren = (n.children || [])
    .map(c => serializeSlotNode(c, nodes, slotConnections, visited))
    .filter((c): c is SerializedSlotNode => c !== null);

  // If this node has its OWN slot connections (it's a slot-bearing component
  // that was wired as a canvas-node into another slot), recurse into them.
  // The serialized result reads the same shape the live site renders —
  // `<Marquee>{cn_leaf}</Marquee>` becomes a serialized Marquee with cn_leaf
  // as its child here.
  //
  // Slot-resolved children carry CANVAS-WORKSPACE positioning (the
  // `left/top` from when they lived as free-floating canvas nodes), NOT
  // in-frame positioning. Strip those on each slot-resolved root —
  // otherwise the leaf renders at its authored workspace coords inside
  // the parent ghost (e.g. -260px / -20px → off-screen, ghost looks
  // empty). buildOne already strips workspace positioning for the
  // top-level slot child via its `isRoot` flag; this mirrors it for
  // every NESTED level reached via slot wiring (inline `n.children`
  // descendants keep their styles because those ARE real in-frame
  // positions).
  const slotKids = slotConnections?.get(id) ?? [];
  const slotChildren = slotKids
    .map(cid => {
      const sn = serializeSlotNode(cid, nodes, slotConnections, visited);
      if (!sn) return null;
      const stripped = { ...sn.styles };
      delete stripped.position;
      delete stripped.left;
      delete stripped.top;
      delete stripped.right;
      delete stripped.bottom;
      return { ...sn, styles: stripped };
    })
    .filter((c): c is SerializedSlotNode => c !== null);

  return {
    type: n.type,
    styles: { ...(n.styles || {}) },
    attrs: { ...(n.attrs || {}) },
    textContent: n.textContent,
    hasMixedContent: n.hasMixedContent,
    children: [...inlineChildren, ...slotChildren],
  };
}

/** Serialize the canvas nodes connected into a component's slot.
 *  `connectedIds` comes from `getAllSlotConnections` (slot-ops.ts).
 *  `slotConnections` is the file-level slot graph (passed by the host) so
 *  nested slot-bearing canvas nodes resolve their own wirings recursively. */
export function serializeSlotChildren(
  connectedIds: string[],
  nodes: Map<string, CanvasNode>,
  slotConnections?: Map<string, string[]>,
): SerializedSlotNode[] {
  return connectedIds
    .map(cid => serializeSlotNode(cid, nodes, slotConnections))
    .filter((c): c is SerializedSlotNode => c !== null);
}

/**
 * Build one ghost React element from a serialized node.
 *
 * `isRoot` — only the CONNECTED node itself carries canvas-workspace
 * positioning (the host component lays it out). Its descendants keep their
 * own `left/top`, which is real in-frame positioning — stripping those
 * would freeze nested children at the wrong spot.
 */
function buildOne(sn: SerializedSlotNode, key: string, isRoot: boolean): React.ReactElement {
  const style: Record<string, any> = { ...sn.styles };
  if (isRoot) {
    delete style.position;
    delete style.left;
    delete style.top;
    delete style.right;
    delete style.bottom;
  }

  const props: Record<string, any> = { key, style };
  for (const [k, v] of Object.entries(sn.attrs)) {
    // Strip editor-only data-* attrs so the ghost carries no data-id
    // (no selection collision with the real floating copy).
    if (k.startsWith('data-')) continue;
    props[k] = v;
  }

  // Only plain HTML tags render as ghosts; component-instance slot children
  // fall back to a div (rare — slot content is normally frames).
  const tag = /^[a-z]/.test(sn.type) ? sn.type : 'div';

  // RICH TEXT — `textContent` holds raw inner JSX, so convert it to HTML and
  // inject as markup. As a plain text child React escaped it and the ghost
  // painted `<span style={{ color: 'rgb(255,255,255)' }}>hi</span>` literally
  // inside the component (user report 2026-07-26). A mixed-content node has no
  // MODEL children (its spans aren't nodes), so nothing is lost by replacing
  // them — and `dangerouslySetInnerHTML` may not coexist with children.
  if (sn.hasMixedContent && sn.textContent) {
    props.dangerouslySetInnerHTML = { __html: jsxStyleToHTML(sn.textContent) };
    return React.createElement(tag, props);
  }

  const kids = sn.children.length > 0
    ? sn.children.map((c, i) => buildOne(c, String(i), false))
    : (sn.textContent || undefined);

  return React.createElement(tag, props, kids);
}

/** Rebuild serialized slot children as React ghost elements. */
export function buildSlotChildren(serialized: SerializedSlotNode[]): React.ReactNode[] {
  return serialized.map((sn, i) => buildOne(sn, String(i), true));
}
