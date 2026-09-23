// src/ai/agent/tools/flow-placement.ts
//
// What a child of a LAYOUT needs to be a valid, visible, reorderable child.
//
// In this builder a flex/grid child's place among its siblings is its CSS
// `order`, not where its tag sits in the JSX — drag-to-reorder rewrites `order`
// and nothing else. And every flow child carries `flex: '0 0 auto'`, because a
// child left on the CSS default (shrink: 1) collapses to zero in a constrained
// column. The editor's own drop / reorder paths write both. The AGENT's tools
// wrote neither, so on its DEFAULT path:
//
//   • add_node / add_component_instance / extract_component into a flex parent
//     produced a page the oracle rejects (FLEX_CHILD_MISSING_ORDER,
//     FLEX_CHILD_SHRINKS) — found by the capability suite, 2026-09-21;
//   • reorder_node moved the tag and left `order` alone, so "move the third
//     card to the front" replied ok and nothing on the page moved.
//
// One module so the five tools that place children agree with each other and
// with the editor.

import type { CanvasNode } from '@/code/parsing/parser';

export type NodeMap = Map<string, CanvasNode>;
export interface OrderWrite { id: string; order: string }

const LAYOUT_DISPLAYS = new Set(['flex', 'inline-flex', 'grid', 'inline-grid']);

export function isLayoutParent(parent: CanvasNode | undefined | null): boolean {
  return !!parent && LAYOUT_DISPLAYS.has(String(parent.styles?.display ?? ''));
}

export function isOutOfFlow(styles: Record<string, unknown> | undefined): boolean {
  const p = String(styles?.position ?? '');
  return p === 'absolute' || p === 'fixed';
}

const orderOf = (n: CanvasNode | undefined): number => {
  const v = Number(n?.styles?.order);
  return Number.isFinite(v) ? v : Number.POSITIVE_INFINITY;
};

/** The parent's in-flow children in the order the user SEES them: by `order`,
 *  JSX position breaking ties (and placing children that have no order yet). */
export function visualFlowChildren(parent: CanvasNode, nodes: NodeMap): string[] {
  return parent.children
    .map((id, jsx) => ({ id, jsx, node: nodes.get(id) }))
    .filter((c) => c.node && !isOutOfFlow(c.node.styles))
    .sort((a, b) => (orderOf(a.node) - orderOf(b.node)) || (a.jsx - b.jsx))
    .map((c) => c.id);
}

/** `order` writes that make `sequence` the visible order — only for the
 *  children whose value actually changes. */
function renumber(sequence: readonly string[], nodes: NodeMap, skip?: string): OrderWrite[] {
  const out: OrderWrite[] = [];
  sequence.forEach((id, i) => {
    if (id === skip) return;
    if (String(nodes.get(id)?.styles?.order ?? '') !== String(i)) out.push({ id, order: String(i) });
  });
  return out;
}

const clampIndex = (index: number | undefined, length: number): number =>
  (index == null || !Number.isFinite(index) ? length : Math.max(0, Math.min(length, Math.floor(index))));

/** Stand-in id for the child that does not exist yet. No real data-id can be
 *  this: ids are lowercase letters, digits and hyphens. */
const NEW_CHILD = '<new>';

/**
 * Styles for a node about to become a child of `parent`, plus the sibling
 * `order` writes that make room for it. Outside a layout (or for an
 * absolute/fixed child) only `position` is guaranteed — every node needs one.
 * Anything the caller already set wins: this fills gaps, it never overrides.
 */
export function seedFlowChild(
  styles: Record<string, string>,
  parent: CanvasNode | undefined | null,
  nodes: NodeMap,
  index?: number,
): { styles: Record<string, string>; siblings: OrderWrite[] } {
  const out: Record<string, string> = { ...styles };
  if (!out.position) out.position = 'relative';
  if (!parent || !isLayoutParent(parent) || isOutOfFlow(out)) return { styles: out, siblings: [] };

  const hasFlex = ['flex', 'flexGrow', 'flexShrink', 'flexBasis'].some((k) => k in out);
  if (!hasFlex) out.flex = '0 0 auto';

  const current = visualFlowChildren(parent, nodes);
  const at = clampIndex(index, current.length);
  const sequence = [...current.slice(0, at), NEW_CHILD, ...current.slice(at)];
  if (!('order' in styles)) out.order = String(at);
  return { styles: out, siblings: renumber(sequence, nodes, NEW_CHILD) };
}

/**
 * The `order` writes that put `nodeId` at visible position `index` among its
 * parent's flow children. Empty when the parent is not a layout (JSX order is
 * the visible order there) or the node is not one of its flow children.
 */
export function planReorder(parent: CanvasNode | undefined | null, nodes: NodeMap, nodeId: string, index: number): OrderWrite[] {
  if (!parent || !isLayoutParent(parent)) return [];
  const current = visualFlowChildren(parent, nodes);
  if (!current.includes(nodeId)) return [];
  const rest = current.filter((id) => id !== nodeId);
  const at = clampIndex(index, rest.length);
  return renumber([...rest.slice(0, at), nodeId, ...rest.slice(at)], nodes);
}

/** Flow styles an element taking ANOTHER element's place must inherit, so the
 *  swap is invisible (extract_component replaces a node with its instance). */
export function inheritedFlowStyles(original: CanvasNode | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['position', 'order', 'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf', 'left', 'top', 'right', 'bottom', 'zIndex', 'gridColumn', 'gridRow']) {
    const v = original?.styles?.[key];
    if (v != null && v !== '') out[key] = String(v);
  }
  if (!out.position) out.position = 'relative';
  return out;
}
