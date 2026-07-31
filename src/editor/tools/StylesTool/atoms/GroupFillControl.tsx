// GroupFillControl.tsx — Fill ToolAtom for an SVG GROUP (a <svg> wrapper
// whose children are themselves <svg> shape wrappers).
//
// A group has no fill of its own — the visible color lives on each leaf
// shape's `fill` attribute. So this control:
//   READS  — walks every descendant shape-bearing <svg> under the group
//            and collects their inner-shape `fill` attrs. All equal →
//            shows that color. They differ → shows "Mixed".
//   WRITES — fans the chosen color out to EVERY leaf shape, using the
//            same dual-write SvgShapeTool/RotateControl use for inner-shape
//            attrs: `queueMutation({ type: 'updateSvgAttrs' })` for source
//            persistence + `bridge.setChildShapeAttribute` for instant
//            iframe-DOM feedback.
//
// Single color swatch only (no gradient/image) — a group recolor is a
// "make all these shapes one color" gesture; per-shape gradients stay
// editable by selecting the individual shape (SvgShapeTool).

import { useCallback } from 'react';
import { ColorInput, ControlLabel } from '../../../controls';
import { useControl } from '../../../controls/ControlProvider';
import { useNodesComputed } from '@/code/stores/node-family';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { findSvgShapeChild, getViewportPrefix } from '@/canvas/node-ops';
import type { CanvasNode } from '@/code/parsing/parser';
import { trace } from '@/shared/debug-trace';

export interface GroupShapeRef {
  /** The leaf <svg> wrapper id (childIndex 0 holds the shape we recolor). */
  svgId: string;
  /** The inner shape CanvasNode (polygon/path/…) whose `fill` we read. */
  shape: CanvasNode;
}

/** Walk the group, collecting every descendant leaf shape-bearing <svg>.
 *  A child <svg> that has a shape child (polygon/path/…) is a leaf; a
 *  child <svg> whose own children are <svg>s is a nested group → recurse.
 *  Exported pure (no React/bridge deps) so it can be unit-tested. */
export function collectGroupShapeSvgs(
  groupNode: CanvasNode | null | undefined,
  nodes: Map<string, CanvasNode>,
  out: GroupShapeRef[] = [],
): GroupShapeRef[] {
  if (!groupNode || !Array.isArray(groupNode.children)) return out;
  for (const cid of groupNode.children) {
    const child = nodes.get(cid);
    if (!child || child.type !== 'svg') continue;
    const shapeChild = findSvgShapeChild(child, nodes, 0);
    if (shapeChild) out.push({ svgId: cid, shape: shapeChild.node });
    else collectGroupShapeSvgs(child, nodes, out); // nested group
  }
  return out;
}

export function GroupFillControl() {
  const { node, vpId } = useControl();

  // ─── Read — collect leaf shapes + detect common color / Mixed ──────────
  const { shapes, fill, isMixed } = useNodesComputed((nodes) => {
    const out = collectGroupShapeSvgs(node, nodes);
    const fills = new Set<string>();
    for (const { shape } of out) {
      // Default SVG fill is black when the attr is absent — normalise so
      // an explicit `#000000` and an absent attr don't read as "Mixed".
      fills.add((shape.attrs?.fill || '#000000').trim());
    }
    return {
      shapes: out,
      fill: fills.size === 1 ? Array.from(fills)[0] : '',
      isMixed: fills.size > 1,
    };
  }, [node]);

  // ─── Live (per-frame) — paint every leaf shape's fill via the bridge only,
  // NO mutation-queue write. Routing the picker's per-frame callback straight
  // to `handleChange` (→ queueMutation per shape per frame) is what made the
  // group-fill picker low-FPS. The code write lands once on release.
  const handleChangeLive = useCallback((color: string) => {
    if (!color) return;
    const vpPrefix = getViewportPrefix(vpId);
    const bridge = getCanvasBridge() as {
      setChildShapeAttribute?: (parent: string, vp: string, idx: number, attr: string, value: string | null) => void;
    };
    for (const { svgId } of shapes) {
      bridge.setChildShapeAttribute?.(svgId, vpPrefix, 0, 'fill', color);
    }
  }, [vpId, shapes]);

  // ─── Write (commit) — fan the chosen color out to every leaf shape ─────
  const handleChange = useCallback((color: string) => {
    if (!color) return;
    trace.action('group-fill:change', { groupId: node?.id, color, shapeCount: shapes.length });
    const vpPrefix = getViewportPrefix(vpId);
    const bridge = getCanvasBridge() as {
      setChildShapeAttribute?: (parent: string, vp: string, idx: number, attr: string, value: string | null) => void;
    };
    for (const { svgId } of shapes) {
      queueMutation({ type: 'updateSvgAttrs', nodeId: svgId, attrs: { fill: color }, childIndex: 0 });
      bridge.setChildShapeAttribute?.(svgId, vpPrefix, 0, 'fill', color);
    }
  }, [node?.id, vpId, shapes]);

  if (!node || shapes.length === 0) return null;

  return (
    <div className="flex items-center justify-between w-full">
      <ControlLabel label="Fill" property="__group-fill" plain />
      <div className="flex items-center gap-2 w-full">
        <ColorInput
          // When Mixed, ColorInput shows a "Mixed" label + checkerboard
          // swatch INSIDE the button; `value` is just the picker's start
          // color. Picking any color fans out and unifies all shapes.
          value={fill || '#000000'}
          mixed={isMixed}
          onChange={handleChange}
          onChangeLive={handleChangeLive}
          showAlpha
        />
      </div>
    </div>
  );
}
