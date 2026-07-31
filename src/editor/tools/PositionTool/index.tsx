// PositionTool — Full position control: type, alignment, pins, coordinates.
// Shows different controls based on position type and parent context.

import { useCallback, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { ToolSection, ToolDivider, StyleField } from '../../controls';
import AlignmentControl from './AlignmentControl';
import PositionTypeControl from './PositionTypeControl';
import PinControl from './PinControl';
import SpaceControl from './SpaceControl';
import { getContentRoot, findNodeSize, findNodeParentInnerSize, findNodeComputedStyle, updateNodeStyles } from '@/canvas/node-ops';
import { transformManager } from '@/canvas/transform';
import { nodeTreeStructureVersionAtom, getNodeFromCache } from '@/code/stores/store';
import { useNode, useNodesComputed } from '@/code/stores/node-family';
import { trace } from '@/shared/debug-trace';

interface Props {
  nodeId: string;
  styles: Record<string, string>;
  vpId: string;
  isReplica: boolean;
  vpWidth: number;
  isTopLevel?: boolean;
}

export default function PositionTool({ nodeId, styles, vpId, isReplica, vpWidth, isTopLevel }: Props) {
  // During a REPARENT drag the node's parentId changes (canvas node → child of
  // a frame → absolute-in-frame), which flips this panel from the "Space" X/Y
  // coords to the L/T/R/B pins. That change lands in the IMPERATIVE node cache
  // mid-drag (moveNodeInCache) and bumps nodeTreeStructureVersionAtom — but
  // nodesAtom stays FROZEN until mouseup (the reparent commits are gated for
  // perf). Reading parentId from the live cache + re-rendering on the version
  // bump makes the Space↔pins switch happen DURING the drag, like it used to,
  // with zero parse. Falls back to the per-node subscription when the cache is
  // empty.
  const structureVersion = useAtomValue(nodeTreeStructureVersionAtom);
  const atomNode = useNode(nodeId);
  const liveNode = useMemo(
    () => getNodeFromCache(nodeId) ?? atomNode,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodeId, atomNode, structureVersion],
  );
  const position = styles.position || '';
  const isAbsolute = position === 'absolute';
  const isFixed = position === 'fixed';
  const isSticky = position === 'sticky';
  const hasPosition = !!position;

  // Is this element absolute-positioned inside a non-static parent? (absolute-in-frame)
  const isAbsoluteInFrame = useMemo(() => {
    if (!isAbsolute) return false;
    if (!liveNode?.parentId) return false;
    const parentPos = findNodeComputedStyle(liveNode.parentId, vpId, 'position');
    return parentPos === 'relative' || parentPos === 'absolute' || parentPos === 'fixed';
  }, [isAbsolute, vpId, liveNode]);

  // An SVG GROUP (a <svg> wrapper whose children are themselves <svg> shapes) is
  // positioned as a single unit by plain left/top — the pin/inset model (anchor
  // to an edge, half/full inset) doesn't apply to a vector group and just
  // clutters the panel. Suppress the PinControl for groups: they always get the
  // simple X/Y coords (default left/top) + the alignment icons.
  const isSvgGroup = useNodesComputed(
    (nodes) => {
      if (liveNode?.type !== 'svg' || !Array.isArray(liveNode.children)) return false;
      return liveNode.children.some((cid) => (getNodeFromCache(cid) ?? nodes.get(cid))?.type === 'svg');
    },
    [liveNode],
  );

  const showPins = (isAbsoluteInFrame || isFixed) && !isSvgGroup;
  const showCoords = (isAbsolute || isFixed) && !showPins;

  // ─── Update helpers ───────────────────────────────────────────────

  // Single style update — imperative-first: DOM + cache + queue.
  // Always routes through `updateNodeStyles` (no separate replica
  // branch). That function already handles the page-vs-replica split
  // via ReplicaContext AND the solo-replica redirect (a node carrying
  // `data-replica-solo="<vpId>"` writes to BASE inline so master
  // values land there). A local short-circuit to
  // `updateContainerStyle` skipped both, breaking the solo redirect
  // for pin / position writes.
  const updateStyle = useCallback((key: string, value: string) => {
    const contentEl = getContentRoot();
    if (contentEl) {
      updateNodeStyles({ id: nodeId, styles: { [key]: value }, contentEl });
    }
    void isReplica; void vpWidth; // kept for clarity (consumed by updateNodeStyles via global context)
  }, [nodeId, isReplica, vpWidth]);

  // Multiple styles at once — imperative-first: DOM + cache + queue.
  // Same routing rationale as `updateStyle` above.
  const updateMultipleStyles = useCallback((newStyles: Record<string, string>) => {
    const contentEl = getContentRoot();
    if (contentEl) {
      updateNodeStyles({ id: nodeId, styles: newStyles, contentEl });
    }
    trace.action('position:update-multiple', { nodeId, styles: newStyles });
  }, [nodeId, isReplica, vpWidth]);

  // ─── Rect getters for alignment ───────────────────────────────────

  const getElementRect = useCallback(() => {
    // `findNodeSize` reports the element rect in PARENT-SCREEN space — it's
    // scaled by the canvas zoom. The parent rect (`findNodeParentInnerSize`
    // → `clientWidth`) is a layout property, zoom-independent. Divide the
    // element by the current zoom so both rects are in the same true-CSS-px
    // space — otherwise alignment is off by (1 − scale) × elementSize (e.g.
    // a half-width overflow at 50% zoom).
    const size = findNodeSize(nodeId, vpId);
    const scale = transformManager.getTransform().scale || 1;
    return { width: size.width / scale, height: size.height / scale };
  }, [nodeId, vpId]);

  const getParentRect = useCallback(() => {
    return findNodeParentInnerSize(nodeId, vpId);
  }, [nodeId, vpId]);

  // Top-level nodes (canvas nodes, variant roots): only show X/Y space
  if (isTopLevel) {
    return (
      <>
        <ToolSection title="Position">
          <SpaceControl
            left={styles.left || '0px'}
            top={styles.top || '0px'}
            nodeId={nodeId}
            vpId={vpId}
            onUpdate={updateStyle}
          />
        </ToolSection>
        <ToolDivider />
      </>
    );
  }

  return (
    <>
      <ToolSection title="Position">
        {/* Alignment icons — accent blue when enabled, disabled gray otherwise */}
        <AlignmentControl
          nodeId={nodeId}
          enabled={isAbsolute || isFixed}
          styles={styles}
          onUpdate={updateMultipleStyles}
          getElementRect={getElementRect}
          getParentRect={getParentRect}
        />

        {/* Position type dropdown */}
        <PositionTypeControl
          position={position || 'static'}
          nodeId={nodeId}
          vpId={vpId}
          existingTransform={styles.transform}
          onUpdateMultiple={updateMultipleStyles}
        />

        {/* Pin control (absolute-in-frame or fixed) */}
        {showPins && (
          <PinControl
            styles={styles}
            nodeId={nodeId}
            vpId={vpId}
            onUpdate={updateStyle}
            onUpdateMultiple={updateMultipleStyles}
          />
        )}

        {/* Simple X/Y coordinates (absolute/fixed without pins) */}
        {showCoords && (
          <SpaceControl
            left={styles.left || '0px'}
            top={styles.top || '0px'}
            nodeId={nodeId}
            vpId={vpId}
            onUpdate={updateStyle}
          />
        )}

        {/* Sticky offset — the scroll distance at which the element sticks */}
        {isSticky && (
          <StyleField property="top" label="Top" defaultValue="0px" />
        )}
      </ToolSection>
      <ToolDivider />
    </>
  );
}
