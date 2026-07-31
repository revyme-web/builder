// SlotConnectionHandle.tsx — connect canvas nodes into a code-component slot.
//
// When a slot-bearing code component (a component whose @controls declares
// a `type: "slot"` entry — e.g. LensBox) is selected on the canvas, a
// purple handle appears on its right edge. Dragging from it to a free
// canvas node fires a `connectSlot` mutation, which moves that node into
// the component tag as a real JSX child (see slot-ops.ts).
//
// While dragging, the line LOCKS onto a target canvas node — a stepped,
// solid connector + an outline on the target — exactly like the variant
// `ConnectionHandle`.

import { useState, useCallback, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { createPortal } from 'react-dom';
import { selectedNodeAtom, canvasInteractingAtom, codeAtom, slotReconnectDragAtom, getNodesSnapshot } from '@/code/stores/store';
import { useNode, useNodesComputed } from '@/code/stores/node-family';
import { suppressSelectionOverlayAtom } from '@/code/stores/editor-store';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { getNodeHitsAtPoint, findNodeRect, patchNodeStyles, getContentRoot } from '@/canvas/node-ops';
import { collectAncestorIds, isEligibleSlotTarget } from '@/canvas/slot-children';
import { usePolledValue } from '@/canvas/hooks/usePolledValue';
import { getScreenCornersById, cornersFromRect, midpoint } from '@/canvas/resize/geometry-utils';
import { getEdgeCenterFromQuad, getClosestEdgeCenterFromQuad, generateSlotConnectorPath } from '@/canvas/ui/arrow-path';
import { projectFS } from '@/code/project/project-fs';
import { parseComponentControlsMeta, type SlotMax } from '@/code/components/controls-parser';
import { queueMutation, flushNow, setForceRender } from '@/code/mutation/mutation-queue';
import { getSlotConnections } from '@/code/generation/slot-ops';
import { trace } from '@/shared/debug-trace';
import { COMPONENT_COLOR } from '@/shared/constants';

// slot-handle tint reads live COMPONENT_COLOR (mirrors --accent-secondary)

export default function SlotConnectionHandle() {
  const selectedId = useAtomValue(selectedNodeAtom);
  // Per-node/per-computation subscriptions + imperative callback reads —
  // this handle no longer re-renders on every commit.
  const isInteracting = useAtomValue(canvasInteractingAtom);
  const vpId = useAtomValue(interactingViewportIdAtom);
  // Same gate the SelectionOverlay uses — set true by `enterComponentFile`
  // across a file switch so polled overlays don't paint against stale
  // rect-cache entries from the previous file (e.g. a Marquee with the
  // same data-id in both page and component master).
  const suppressOverlay = useAtomValue(suppressSelectionOverlayAtom);
  // Reset handle position on file switch — see the matching block in
  // SelectionOverlay. Without this the handle paints at the previous
  // file's cached corners until the next poll lands a fresh non-null.
  const activeFilePath = useAtomValue(activeFilePathAtom);

  const selectedNode = useNode(selectedId) ?? null;

  // Detect a slot-bearing code component: its source must declare one or
  // more `type: "slot"` controls. `count` = how many slots it has (= dots
  // on the handle); `max` = the first slot's connection cap.
  const slotInfo = useMemo<{ count: number; max: SlotMax } | null>(() => {
    if (!selectedNode?.isCodeComponent || !selectedNode.componentFile) return null;
    if (selectedNode.componentFile.startsWith('http')) return null;
    const src = projectFS.readFile(selectedNode.componentFile);
    if (!src) return null;
    const meta = parseComponentControlsMeta(src);
    if (!meta) return null;
    const slots = Object.values(meta.controls).filter(c => c.type === 'slot');
    if (slots.length === 0) return null;
    return { count: slots.length, max: slots[0].slotMax ?? 'infinite' };
  }, [selectedNode]);

  // Connected nodes — slot is full when their count reaches `max`.
  const code = useAtomValue(codeAtom);
  const setSlotReconnectDrag = useSetAtom(slotReconnectDragAtom);
  const connectedIds = useMemo(
    () => (selectedId ? getSlotConnections(code, selectedId) : []),
    [code, selectedId],
  );
  const connectedCount = connectedIds.length;
  const max = slotInfo == null || slotInfo.max === 'infinite' ? Infinity : slotInfo.max;
  // A single slot caps at one connection — but its handle stays put even when
  // full, so dragging it RE-CONNECTS (replace) instead of adding.
  const isSingleSlot = max === 1;
  const full = connectedCount >= max;

  // The component's viewport-root id — used to run the connector's
  // horizontal exit out past the viewport's right edge.
  const rootId = useNodesComputed((nodes) => {
    let r: typeof selectedNode | undefined = selectedNode;
    while (r && r.parentId) r = nodes.get(r.parentId);
    return r?.id ?? null;
  }, [selectedNode]);

  const [isDragging, setIsDragging] = useState(false);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  /** Stepped path locked to a target canvas node — null while free-dragging. */
  const [dragPath, setDragPath] = useState<string | null>(null);

  // A single slot keeps its handle even when full (re-connect); a multi slot
  // hides it once full so you can't exceed the cap.
  const shouldShow =
    slotInfo != null && !!selectedId && !isInteracting && !suppressOverlay && (!full || isSingleSlot);

  // Track the handle at the component's right-edge midpoint. `resetKey`
  // clears the pos on file switch so it doesn't paint at the previous
  // file's coords until the next poll lands fresh corners.
  const handlePos = usePolledValue<{ x: number; y: number }>(
    shouldShow && !!selectedId,
    (prev) => {
      const corners = getScreenCornersById(selectedId!, vpId);
      if (corners) {
        const mid = midpoint(corners.TR, corners.BR);
        return { x: mid.x, y: mid.y };
      }
      return prev;
    },
    [selectedId, vpId],
    { resetKey: activeFilePath },
  );

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!selectedId) return;
    setIsDragging(true);
    setCursorPos({ x: e.clientX, y: e.clientY });

    // Single slot already wired → this drag is a RE-CONNECT. The existing
    // connection visually detaches for the drag (SlotConnectors hides it via
    // `slotReconnectDragAtom`); on drop it either moves to a new target or,
    // if dropped on nothing / back on itself, snaps back unchanged.
    const reconnect = isSingleSlot && connectedIds.length > 0;
    const originalId = reconnect ? connectedIds[0] : null;
    if (reconnect) setSlotReconnectDrag(selectedId);

    const contentEl = getContentRoot();
    let prevTargetId: string | null = null;

    const clearOutline = () => {
      if (prevTargetId && contentEl) {
        patchNodeStyles(contentEl, prevTargetId, '', { outline: '', outlineOffset: '' });
      }
      prevTargetId = null;
    };

    // The component lives INSIDE a top-level canvas node (its containing Frame),
    // which would otherwise pass the canvas-node test below — but wiring the slot
    // to it makes the component render its OWN container (a cycle). Exclude the
    // whole ancestor chain (see isEligibleSlotTarget).
    const nodes = getNodesSnapshot();
    const ancestorIds = collectAncestorIds(nodes, selectedId);

    // The free canvas node under the cursor — a valid slot drop target (top-level
    // canvas node, not the component itself, not an ancestor, not already wired).
    const canvasNodeAt = (x: number, y: number): string | null => {
      for (const hit of getNodeHitsAtPoint(x, y)) {
        const n = nodes.get(hit.id);
        if (isEligibleSlotTarget(n, { componentId: selectedId, ancestorIds, connectedIds, isSingleSlot })) {
          return n!.id;
        }
      }
      return null;
    };

    const move = (me: PointerEvent) => {
      setCursorPos({ x: me.clientX, y: me.clientY });
      const targetId = canvasNodeAt(me.clientX, me.clientY);

      if (targetId) {
        // Lock the connector: stepped path from the component edge to the
        // target canvas node edge, and outline the target.
        // Canvas nodes are cached under the primary ('') prefix — look them
        // up with 'desktop' (getViewportPrefix('') wrongly yields '-').
        const sourceRect = findNodeRect(selectedId, vpId || 'desktop');
        const targetRect = findNodeRect(targetId, 'desktop');
        if (sourceRect && targetRect) {
          const fromQuad = cornersFromRect(sourceRect);
          const toQuad = cornersFromRect(targetRect);
          // Horizontal exit past the viewport's right edge, then the
          // regular angled path into the target's closest edge.
          const sourceEdge = getEdgeCenterFromQuad(fromQuad, 'right');
          const vpRect = rootId ? findNodeRect(rootId, vpId || 'desktop') : null;
          const exitX = vpRect ? vpRect.right + 14 : sourceEdge.point.x + 48;
          const elbow = { x: Math.max(exitX, sourceEdge.point.x + 12), y: sourceEdge.point.y };
          const targetEdge = getClosestEdgeCenterFromQuad(toQuad, elbow);
          setDragPath(generateSlotConnectorPath(sourceEdge.point, targetEdge.point, targetEdge.dir, exitX));
        }
        if (targetId !== prevTargetId) {
          clearOutline();
          if (contentEl) {
            patchNodeStyles(contentEl, targetId, '', {
              outline: `2px solid ${COMPONENT_COLOR}`,
              outlineOffset: '0px',
            });
          }
          prevTargetId = targetId;
        }
      } else {
        clearOutline();
        setDragPath(null);
      }
    };

    const up = (me: PointerEvent) => {
      const targetId = canvasNodeAt(me.clientX, me.clientY);
      if (targetId && targetId !== originalId) {
        if (reconnect && originalId) {
          // Single-slot replace — drop the old reference, add the new one.
          trace.action('slot-connection-handle:reconnect', { componentId: selectedId, from: originalId, to: targetId });
          queueMutation({ type: 'disconnectSlot', componentId: selectedId, canvasNodeId: originalId });
          queueMutation({ type: 'connectSlot', componentId: selectedId, canvasNodeId: targetId });
        } else {
          trace.action('slot-connection-handle:connect', { componentId: selectedId, canvasNodeId: targetId });
          queueMutation({ type: 'connectSlot', componentId: selectedId, canvasNodeId: targetId });
        }
        // The connected node renders INSIDE the code component (SparkHost
        // children come from the expanded parse) — a patch cycle can't grow
        // them, so force a full Renderer rebuild and flush NOW. Without
        // this the component only showed the new child after some later
        // unrelated render (the "connect does nothing until I nudge a
        // frame" report).
        setForceRender();
      }
      // Dropped on nothing or back on the original → snap back (no mutation).
      clearOutline();
      // Flush the connection change into `code` BEFORE clearing the detach
      // flag, so SlotConnectors swaps straight to the new connector in one
      // batched render (and the forced full render above materializes the
      // slot child instantly on plain connects too).
      if (targetId && targetId !== originalId) flushNow();
      else if (reconnect) flushNow();
      setSlotReconnectDrag(null);
      setIsDragging(false);
      setCursorPos(null);
      setDragPath(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [selectedId, vpId, rootId, isSingleSlot, connectedIds, setSlotReconnectDrag]);

  if (!shouldShow || !handlePos) return null;

  // Locked-on → solid orthogonal path; free-dragging → same routing to the
  // cursor (dashed). Both exit the handle straight horizontal.
  let linePath: string | null = null;
  if (isDragging) {
    if (dragPath) linePath = dragPath;
    else if (cursorPos) linePath = generateSlotConnectorPath(handlePos, cursorPos, { x: -1, y: 0 }, handlePos.x + 60);
  }

  // Handle — a vertical accent capsule holding one white dot per CONNECTED
  // canvas node (min 1 so the handle stays grabbable when nothing's wired).
  const dotCount = Math.max(1, connectedCount);
  const DOT = 6, GAP = 1.5, PAD = 5, PILL_W = 16;
  const pillH = dotCount * DOT + (dotCount - 1) * GAP + PAD * 2;

  return createPortal(
    <>
      <div
        onPointerDown={handlePointerDown}
        style={{
          position: 'fixed',
          left: handlePos.x - PILL_W / 2,
          top: handlePos.y - pillH / 2,
          width: PILL_W,
          height: pillH,
          borderRadius: PILL_W / 2,
          background: COMPONENT_COLOR,
          boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: GAP,
          cursor: 'pointer',
          pointerEvents: 'auto',
          zIndex: 3000,
        }}
        title="Drag to connect a canvas node into this slot"
      >
        {Array.from({ length: dotCount }).map((_, i) => (
          <div
            key={i}
            style={{ width: DOT, height: DOT, borderRadius: '50%', background: 'white' }}
          />
        ))}
      </div>

      {isDragging && linePath && (
        <svg
          style={{
            position: 'fixed', left: 0, top: 0,
            width: '100vw', height: '100vh',
            pointerEvents: 'none', zIndex: 2999,
          }}
        >
          <path
            d={linePath}
            fill="none"
            stroke={COMPONENT_COLOR}
            strokeWidth={2}
            strokeDasharray={dragPath ? 'none' : '6 4'}
            strokeLinecap="round"
          />
        </svg>
      )}
    </>,
    document.body,
  );
}
