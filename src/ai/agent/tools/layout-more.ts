// src/ai/agent/tools/layout-more.ts
//
// The Size / Layout / Position panels beyond px (audit §7 gaps 2, 4, 5, 7):
// Fill, Fit and relative units; grid columns; rotate / scale; reorder on one
// breakpoint; wrap a selection in a layout; unfold a wrapper. Each write is the
// panel's own — `makeFillFlex` / `crossAxisFillPatch` for Fill, `FIT_SIZE` for
// Fit, the banded `order` write for a per-breakpoint reorder, and
// `wrapInLayout` / `unfoldChildren` (canvas/commands) for the structural ones.

import { z } from 'zod';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import { queueToolMutation, flushTool, getToolNodes, isBranchedRun, getToolCode } from '@/ai/agent/workspace';
import { getDefaultStore } from 'jotai';
import { parseContainerRules } from '@/code/stores/container-query-store';
import { getSortedBreakpointWidths, interactingViewportIdAtom, viewportWidthsAtom } from '@/code/stores/viewport-store';
import { findNodeRect } from '@/canvas/node-ops';
import { toCamel } from '@/shared/css-utils';
import { makeFillFlex, crossAxisFillPatch, isMainAxis } from '@/shared/flex-helpers';
import { FIT_SIZE } from '@/shared/constants';
import { wrapInLayout, unfoldChildren } from '@/canvas/commands';
import { getContentRoot } from '@/canvas/node-ops';
import { isLayoutParent, planReorder, visualFlowChildren } from './flow-placement';
import { trace } from '@/shared/debug-trace';

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

const SIZE_VALUE_RE = /^(-?\d+(\.\d+)?)(px|%|vw|vh)$/;
type Axis = 'width' | 'height';

/**
 * The write for one axis of the Size panel's unit menu.
 *
 *   fill   grow to the available space. In the parent's MAIN axis that is a
 *          grow flex with no size (`flex: 1 0 0px`); in the CROSS axis it is
 *          100% (and, on a replica whose base was fill, the flex is pinned
 *          back so the two axes do not fight).
 *   fit    hug the content (`min-content`).
 *   a value with px / % / vw / vh — as given.
 *   ''     remove the size.
 */
export function sizeWrite(
  axis: Axis,
  value: string,
  parent: { display?: string; flexDirection?: string } | undefined,
  currentFlex: string,
  isReplica: boolean,
): Record<string, string> | { error: string } {
  const v = value.trim();
  if (v === '') return { [axis]: '' };
  if (v === 'fit') return { [axis]: FIT_SIZE };
  if (v === 'fill') {
    if (parent?.display !== 'flex' && parent?.display !== 'inline-flex') {
      return { error: `Fill needs a flex parent — this element's parent is not a layout. Give the parent a layout first (set_layout display:flex), or use "100%".` };
    }
    return isMainAxis(parent.flexDirection ?? 'row', axis)
      ? { [axis]: '', flex: makeFillFlex(1) }
      : crossAxisFillPatch(axis, isReplica, currentFlex);
  }
  if (!SIZE_VALUE_RE.test(v)) return { error: `"${v}" is not a size. Use px, %, vw, vh, "fill", "fit", or "" to remove.` };
  return { [axis]: v };
}

export const setSizeUnitsTool: AgentTool = {
  name: 'set_size_units',
  description:
    'Size an element the way the Size panel\'s unit menu does — beyond px: "fill" (grow to the available space in a layout), "fit" (hug the content), a "%", "vw" or "vh" value, or "" to remove. ' +
    'width / height each take one of those. Fill inside a flex row becomes a grow flex with no width (share the row equally: set every card to width "fill"); in the cross axis it is 100%. ' +
    'Optional viewport (px) writes the size for that breakpoint only. For plain px use set_size.',
  inputSchema: {
    node_id: z.string(),
    width: z.string().optional().describe('"fill" | "fit" | "50%" | "100vw" | "" (remove)'),
    height: z.string().optional().describe('"fill" | "fit" | "60vh" | "" (remove)'),
    viewport: z.number().optional().describe('breakpoint width in px to scope to; omit for base'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    const nodes = getToolNodes(ctx);
    const node = nodes.get(nodeId);
    if (!node) return fail(`No node "${nodeId}" in the active file.`);
    if (args.width === undefined && args.height === undefined) return fail('set_size_units needs width and/or height.');
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    const isReplica = typeof args.viewport === 'number';
    const styles: Record<string, string> = {};
    for (const axis of ['width', 'height'] as const) {
      const v = args[axis];
      if (v === undefined) continue;
      const w = sizeWrite(axis, String(v), parent?.styles, String(node.styles.flex ?? ''), isReplica);
      if ('error' in w) return fail(w.error);
      Object.assign(styles, w);
    }
    ctx.ensureCheckpoint();
    if (isReplica) queueToolMutation(ctx, { type: 'updateContainerStyle', nodeId, maxWidth: args.viewport as number, styles });
    else queueToolMutation(ctx, { type: 'updateStyles', nodeId, styles });
    flushTool(ctx);
    return ok({ node_id: nodeId, styles, viewport: args.viewport ?? null });
  },
};

export const setGridTool: AgentTool = {
  name: 'set_grid',
  description:
    'Make an element a CSS GRID and set its columns / rows / gap — what set_layout cannot express. columns is a track list ("repeat(3, 1fr)", "1fr 2fr", "repeat(auto-fit, minmax(240px, 1fr))"). Children then flow into cells; give one a span with set_styles gridColumn: "span 2".',
  inputSchema: {
    node_id: z.string(),
    columns: z.string().describe('grid-template-columns, e.g. "repeat(3, 1fr)"'),
    rows: z.string().optional().describe('grid-template-rows'),
    gap: z.string().optional().describe('px string, e.g. "24px"'),
    align_items: z.enum(['start', 'center', 'end', 'stretch']).optional(),
    justify_items: z.enum(['start', 'center', 'end', 'stretch']).optional(),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    if (!getToolNodes(ctx).has(nodeId)) return fail(`No node "${nodeId}" in the active file.`);
    const styles: Record<string, string> = { display: 'grid', gridTemplateColumns: String(args.columns) };
    if (args.rows) styles.gridTemplateRows = String(args.rows);
    if (args.gap) {
      if (!/^\d+(\.\d+)?px$/.test(String(args.gap))) return fail('gap must be a px string, e.g. "24px".');
      styles.gap = String(args.gap);
    }
    if (args.align_items) styles.alignItems = String(args.align_items);
    if (args.justify_items) styles.justifyItems = String(args.justify_items);
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'updateStyles', nodeId, styles });
    flushTool(ctx);
    return ok({ node_id: nodeId, styles });
  },
};

export const setTransformTool: AgentTool = {
  name: 'set_transform',
  description:
    'Rotate, scale or skew an element — the Transform panel\'s channels (rotate in degrees, scale as a factor, skew in degrees). Written as the motion-aware `transform` the canvas edits, so the handles keep working. Omit a channel to leave it; pass 0 / 1 to reset it.',
  inputSchema: {
    node_id: z.string(),
    rotate: z.number().optional().describe('degrees'),
    scale: z.number().optional().describe('factor, 1 = none'),
    skew_x: z.number().optional().describe('degrees'),
    skew_y: z.number().optional().describe('degrees'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    const node = getToolNodes(ctx).get(nodeId);
    if (!node) return fail(`No node "${nodeId}" in the active file.`);
    // The oracle accepts exactly the canvas fold's own grammar: single-argument
    // functions in the order scale → rotate → skew (TRANSFORM_STRING lists it).
    // A rotate-only transform is what the Rotate panel writes, with the pivot.
    const current = String(node.styles.transform ?? '');
    const keep = (name: string): string | undefined => current.match(new RegExp(`(?:^|\\s)${name}\\(\\s*-?[\\d.]+(?:deg|rad|turn)?\\s*\\)`))?.[0].trim();
    const scale = args.scale !== undefined ? (Number(args.scale) !== 1 ? `scale(${Number(args.scale)})` : undefined) : keep('scale');
    const rotate = args.rotate !== undefined ? (Number(args.rotate) ? `rotate(${Number(args.rotate)}deg)` : undefined) : keep('rotate');
    const skewX = args.skew_x !== undefined ? (Number(args.skew_x) ? `skewX(${Number(args.skew_x)}deg)` : undefined) : keep('skewX');
    const skewY = args.skew_y !== undefined ? (Number(args.skew_y) ? `skewY(${Number(args.skew_y)}deg)` : undefined) : keep('skewY');
    const parts = [scale, rotate, skewX, skewY].filter((p): p is string => !!p);
    const transform = parts.join(' ');
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'updateStyles', nodeId, styles: transform ? { transform, transformOrigin: '50% 50%' } : { transform: '', transformOrigin: '' } });
    flushTool(ctx);
    return ok({ node_id: nodeId, transform: transform || '(none)' });
  },
};

export const reorderOnBreakpointTool: AgentTool = {
  name: 'reorder_on_breakpoint',
  description:
    'Change an element\'s position among its layout siblings on ONE breakpoint only — "on mobile show the image above the title". Writes the banded `order` for that viewport; the desktop order is untouched. reorder_node changes it everywhere.',
  inputSchema: {
    node_id: z.string(),
    index: z.number().describe('0-based visible position among the parent\'s flow children on that breakpoint'),
    viewport: z.number().describe('breakpoint width in px, e.g. 375'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    const nodes = getToolNodes(ctx);
    const node = nodes.get(nodeId);
    if (!node) return fail(`No node "${nodeId}" in the active file.`);
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (!parent || !isLayoutParent(parent)) return fail(`"${nodeId}" is not inside a layout — order only means something among flex/grid siblings.`);
    const writes = planReorder(parent, nodes, nodeId, Number(args.index));
    if (writes.length === 0) return ok({ node_id: nodeId, viewport: args.viewport, changed: 0, note: 'already at that position' });
    ctx.ensureCheckpoint();
    for (const w of writes) queueToolMutation(ctx, { type: 'updateContainerStyle', nodeId: w.id, maxWidth: Number(args.viewport), styles: { order: w.order } });
    flushTool(ctx);
    trace.action('agent-tool:reorder_on_breakpoint', { nodeId, viewport: args.viewport, writes: writes.length });
    return ok({ node_id: nodeId, viewport: args.viewport, sequence: visualFlowChildren(parent, nodes), changed: writes.length });
  },
};

export const wrapInLayoutTool: AgentTool = {
  name: 'wrap_in_layout',
  description:
    'Group elements inside a NEW flex layout frame — the Create Layout action: the selection\'s siblings become a centred column (direction changeable afterwards with set_layout). node_ids must share one parent and be its flow children. Returns the new frame\'s id.',
  inputSchema: {
    node_ids: z.array(z.string()).min(1),
    name: z.string().optional().describe('display name for the new frame'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    if (isBranchedRun(ctx)) return fail('wrap_in_layout works on the active branch only — run unbranched.');
    const ids = (args.node_ids as string[]).map(String);
    const nodes = getToolNodes(ctx);
    for (const id of ids) if (!nodes.has(id)) return fail(`No node "${id}" in the active file.`);
    const parents = new Set(ids.map((id) => nodes.get(id)!.parentId ?? null));
    if (parents.size !== 1) return fail('wrap_in_layout needs elements that share ONE parent.');
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const root = getContentRoot() ?? (typeof document !== 'undefined' ? document.body : ({} as HTMLElement));
    const frameId = wrapInLayout(ids, nodes, root);
    if (!frameId) return fail('Could not wrap these elements: they must be flow (non-absolute) children of the same parent, or absolutely positioned ones the canvas can measure.');
    flushTool(ctx);
    if (args.name) { queueToolMutation(ctx, { type: 'renameNode', nodeId: frameId, name: String(args.name) }); flushTool(ctx); }
    return ok({ frame_id: frameId, wrapped: ids });
  },
};

export const unfoldChildrenTool: AgentTool = {
  name: 'unfold_children',
  description: 'Remove a wrapper frame and keep what is inside — its children take its place in the parent (the Unfold Children action).',
  inputSchema: { node_id: z.string() },
  category: 'semantic',
  async execute(args, ctx) {
    if (isBranchedRun(ctx)) return fail('unfold_children works on the active branch only — run unbranched.');
    const nodeId = String(args.node_id);
    const nodes = getToolNodes(ctx);
    const node = nodes.get(nodeId);
    if (!node) return fail(`No node "${nodeId}" in the active file.`);
    if (node.children.length === 0) return fail(`"${nodeId}" has no children to unfold — delete_node removes an empty frame.`);
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const root = getContentRoot() ?? (typeof document !== 'undefined' ? document.body : ({} as HTMLElement));
    unfoldChildren(nodeId, nodes, root);
    flushTool(ctx);
    return ok({ unfolded: nodeId, children: node.children });
  },
};

// ─── reset_overrides ─────────────────────────────────────────────────────────

export const resetOverridesTool: AgentTool = {
  name: 'reset_overrides',
  description:
    'Reset a node\'s responsive OVERRIDES on one breakpoint — "reset the mobile version of this card": every style the breakpoint band declares for the node is dropped so it inherits the base again (the panel\'s Reset Override, for all properties at once). ' +
    'Optional properties narrows it to some camelCase properties.',
  inputSchema: {
    node_id: z.string(),
    viewport: z.number().describe('breakpoint width in px, e.g. 375'),
    properties: z.array(z.string()).optional().describe('camelCase properties to reset; omit for all'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    if (!getToolNodes(ctx).get(nodeId)) return fail(`No node "${nodeId}" in the active file.`);
    const width = Number(args.viewport);
    const widths = getSortedBreakpointWidths();
    if (!widths.includes(width)) return fail(`No breakpoint of ${width}px. Breakpoints: ${widths.join(', ')}.`);
    const block = /<style>\s*\{[`']([\s\S]*?)[`']\}\s*<\/style>/.exec(getToolCode(ctx));
    const band = block ? parseContainerRules(block[1]).get(width)?.get(nodeId) : undefined;
    const declared = [...(band?.keys() ?? [])].map(toCamel);
    const wanted = (args.properties as string[] | undefined);
    const props = wanted ? declared.filter((p) => wanted.includes(p)) : declared;
    if (props.length === 0) return ok({ node_id: nodeId, viewport: width, reset: [], note: wanted ? 'none of those properties is overridden on that breakpoint' : 'no overrides on that breakpoint' });
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'updateContainerStyle', nodeId, maxWidth: width, styles: Object.fromEntries(props.map((p) => [p, ''])) });
    flushTool(ctx);
    trace.action('agent-tool:reset_overrides', { nodeId, width, props });
    return ok({ node_id: nodeId, viewport: width, reset: props });
  },
};

// ─── pin_to_side ─────────────────────────────────────────────────────────────

const PX = /^-?\d+(\.\d+)?px$/;
const px = (v: string | undefined): number | null => (v && PX.test(v) ? parseFloat(v) : null);

export const pinToSideTool: AgentTool = {
  name: 'pin_to_side',
  description:
    'Re-anchor an ABSOLUTE element to another side WITHOUT moving it — "pin this badge to the right": the Position panel\'s pin toggle. The current left/top inset is converted to a right/bottom inset (or both, or centred) from the rendered geometry, so the element stays put and now follows that side when the parent resizes. ' +
    'horizontal: left | right | both | center; vertical: top | bottom | both | center (omit an axis to leave it).',
  inputSchema: {
    node_id: z.string(),
    horizontal: z.enum(['left', 'right', 'both', 'center']).optional(),
    vertical: z.enum(['top', 'bottom', 'both', 'center']).optional(),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    const nodes = getToolNodes(ctx);
    const node = nodes.get(nodeId);
    if (!node) return fail(`No node "${nodeId}" in the active file.`);
    if (node.styles.position !== 'absolute' && node.styles.position !== 'fixed') return fail(`"${nodeId}" is in the flow (position ${node.styles.position ?? 'static'}) — pins apply to absolute elements (set_position mode absolute first).`);
    if (!args.horizontal && !args.vertical) return fail('Pass horizontal and/or vertical.');
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    // Geometry: the live canvas when it is there, else px styles (the same
    // numbers, when everything is authored in px).
    const store = getDefaultStore();
    const vpId = store.get(interactingViewportIdAtom);
    const rect = findNodeRect(nodeId, vpId);
    const prect = parent ? findNodeRect(parent.id, vpId) : null;
    let x: number | null, y: number | null, w: number | null, h: number | null, pw: number | null, ph: number | null;
    if (rect && prect) { x = rect.left - prect.left; y = rect.top - prect.top; w = rect.width; h = rect.height; pw = prect.width; ph = prect.height; }
    else {
      const vpW = parent?.parentId ? null : (store.get(viewportWidthsAtom) as Record<string, number>)[vpId] ?? null;
      pw = px(parent?.styles.width) ?? (parent?.styles.width === '100%' ? vpW : null); ph = px(parent?.styles.height);
      w = px(node.styles.width); h = px(node.styles.height);
      const left = px(node.styles.left), right = px(node.styles.right), top = px(node.styles.top), bottom = px(node.styles.bottom);
      x = left ?? (right != null && pw != null && w != null ? pw - right - w : null);
      y = top ?? (bottom != null && ph != null && h != null ? ph - bottom - h : null);
    }
    const styles: Record<string, string> = {};
    const r = (n: number) => `${Math.round(n)}px`;
    if (args.horizontal) {
      if (x == null || w == null || pw == null) return fail(`Cannot measure "${nodeId}" horizontally (no rendered canvas and no px left/width/parent width) — pass explicit insets with set_position instead.`);
      const rightInset = pw - x - w;
      if (args.horizontal === 'left') { styles.left = r(x); styles.right = ''; }
      else if (args.horizontal === 'right') { styles.right = r(rightInset); styles.left = ''; }
      else if (args.horizontal === 'both') { styles.left = r(x); styles.right = r(rightInset); styles.width = ''; }
      else { styles.left = '50%'; styles.right = ''; styles.marginLeft = r(-w / 2); }
    }
    if (args.vertical) {
      if (y == null || h == null || ph == null) return fail(`Cannot measure "${nodeId}" vertically (no rendered canvas and no px top/height/parent height) — pass explicit insets with set_position instead.`);
      const bottomInset = ph - y - h;
      if (args.vertical === 'top') { styles.top = r(y); styles.bottom = ''; }
      else if (args.vertical === 'bottom') { styles.bottom = r(bottomInset); styles.top = ''; }
      else if (args.vertical === 'both') { styles.top = r(y); styles.bottom = r(bottomInset); styles.height = ''; }
      else { styles.top = '50%'; styles.bottom = ''; styles.marginTop = r(-h / 2); }
    }
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'updateStyles', nodeId, styles });
    flushTool(ctx);
    trace.action('agent-tool:pin_to_side', { nodeId, horizontal: args.horizontal, vertical: args.vertical, measured: !!(rect && prect) });
    return ok({ node_id: nodeId, pins: styles, measured_from: rect && prect ? 'canvas' : 'px styles' });
  },
};

export const LAYOUT_MORE_TOOLS: AgentTool[] = [setSizeUnitsTool, setGridTool, setTransformTool, reorderOnBreakpointTool, wrapInLayoutTool, unfoldChildrenTool, resetOverridesTool, pinToSideTool];
