// ConnectionHandle.tsx — Purple dot on right edge of selected variant root.
// Drag to another variant to create a connection.
// On hover over target: locks onto target's left edge midpoint with solid line.
// On drop: triggers ConnectionTypeModal.

import { useState, useCallback, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { createPortal } from 'react-dom';
import { selectedNodeAtom, nodesAtom, canvasInteractingAtom, codeAtom } from '@/code/stores/store';
import { activeFilePathAtom, isComponentFilePath } from '@/code/project/active-file-store';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { findNodeRect, getNodeHitsAtPoint, patchNodeStyles, getContentRoot, getViewportPrefix } from '@/canvas/node-ops';
import { usePolledValue } from '@/canvas/hooks/usePolledValue';
import { getScreenCornersById, cornersFromRect, midpoint } from '@/canvas/resize/geometry-utils';
import { getClosestEdgeCenterFromQuad, generateSteppedPath, quadCenter } from '@/canvas/ui/arrow-path';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { projectFS } from '@/code/project/project-fs';
import { parseComponentControlsMeta } from '@/code/components/controls-parser';
import { COMPONENT_COLOR } from '@/shared/constants';
import { trace } from '@/shared/debug-trace';

const HANDLE_SIZE = 24;
// COMPONENT_COLOR (mirrors --accent-secondary) is read live at render time —
// NOT snapshotted into a const, which would capture the pre-theme fallback.

interface Props {
  onConnectionCreated: (
    fromVariant: string,
    toVariant: string,
    mousePos: { x: number; y: number },
    /** data-id of the element where the user grabbed the handle. The
     *  generated event handler lands on THIS element's JSX tag, so a
     *  click/hover on that specific child triggers the variant switch.
     *  Undefined when the user grabbed the handle on the variant root,
     *  which keeps the legacy "click anywhere on the root" behavior. */
    sourceNodeId?: string,
  ) => void;
}

export default function ConnectionHandle({ onConnectionCreated }: Props) {
  const selectedId = useAtomValue(selectedNodeAtom);
  const nodes = useAtomValue(nodesAtom);
  const activeFile = useAtomValue(activeFilePathAtom);
  const vpId = useAtomValue(interactingViewportIdAtom);

  const [isDragging, setIsDragging] = useState(false);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [targetVariantId, setTargetVariantId] = useState<string | null>(null);

  const isInteracting = useAtomValue(canvasInteractingAtom);
  const code = useAtomValue(codeAtom);

  const isComponent = isComponentFilePath(activeFile);
  const selectedNode = selectedId ? nodes.get(selectedId) : null;

  // The variant root nodeId — the top-level node in the parsed tree.
  // Used during drag to anchor the target outline + arrow tip to the
  // VARIANT (not whatever child happens to share `selectedId` in the
  // target viewport). Without this, dragging from a child stuck the
  // arrow tip + outline to the equivalent child in the target variant
  // instead of the variant block itself — wrong because connections
  // ALWAYS target the variant, never an equivalent child.
  const rootNodeId = useMemo(() => {
    for (const n of nodes.values()) {
      if (!n.parentId && !n.isCanvasNode && n.type !== 'style') return n.id;
    }
    return null;
  }, [nodes]);

  // Show the handle on:
  //   - The variant root (no parentId) — drag creates a connection with
  //     the root as the trigger element (existing behavior).
  //   - Any selected CHILD inside a variant — drag creates a connection
  //     where THAT child carries the event handler. The codegen places
  //     `onTap` (or whichever trigger) on that element's JSX tag, so
  //     clicking that specific child triggers the variant switch.
  // Canvas nodes (free-floating, not part of any variant) never qualify.
  // Neither does ANY svg node — shapes, groups, nested groups, sketches
  // (sketch wrappers are `<svg data-sketch>`, type 'svg' too): vector
  // content can't carry connection triggers (the dialect never places
  // onTap on svg wrappers), and the ⚡ bubble visually collides with the
  // rotate/resize affordances on small shapes (user decision 2026-06-12).
  const isSvgNode = selectedNode?.type === 'svg';
  // Canvas nodes CAN be connected to variants (design-tool parity) — the handle was wrongly hidden on them. A
  // canvas-node connection is stored as `data-conn-target` on the node (it can't run a live `setVariant` at
  // module scope) and rendered as an arrow to the target variant.
  const isOnVariantElement = !!selectedNode && !isSvgNode;

  // Suppress the handle when the active variant is a hover/pressed
  // interaction state. Connections from a state should be created via
  // the auto-wired chain rule in `addInteractionState`, not by hand —
  // and the visual semantics of "drag a handle from a hover state to
  // another variant" are unclear (it's the parent's hover, not a
  // standalone state). Mirrors the AddVariantUI rule that hides the
  // regular Variant button on an interaction-state root.
  const isOnInteractionState = useMemo(() => {
    if (!isComponent) return false;
    const configs = parseVariantConfig(code);
    const variantName = vpId === 'desktop' ? 'default' : vpId;
    const cfg = configs.find(v => v.name === variantName);
    return !!cfg?.interactionType;
  }, [isComponent, code, vpId]);

  // Hide the variant connection handle when the selected node is a
  // slot-bearing code-component instance (e.g. LensBox, Marquee, Carousel).
  // Those instances already show the SLOT connection handle on the same
  // right-edge midpoint — drawing both creates an overlap and the two
  // purple bubbles read as a single ambiguous control. Slot wiring is
  // also semantically unrelated to variant transitions, so the variant
  // handle has no role on a slot-bearing instance.
  const hasSlotControls = useMemo(() => {
    if (!selectedNode?.isCodeComponent || !selectedNode.componentFile) return false;
    if (selectedNode.componentFile.startsWith('http')) return false;
    const src = projectFS.readFile(selectedNode.componentFile);
    if (!src) return false;
    const meta = parseComponentControlsMeta(src);
    if (!meta) return false;
    return Object.values(meta.controls).some(c => c.type === 'slot');
  }, [selectedNode]);

  const shouldShow = isComponent && isOnVariantElement && !!selectedId && !isInteracting && !isOnInteractionState && !hasSlotControls;

  // Track handle position (right edge midpoint of selected variant)
  const handlePos = usePolledValue<{ x: number; y: number }>(
    shouldShow && !!selectedId,
    (prev) => {
      const corners = getScreenCornersById(selectedId!, vpId);
      if (corners) {
        const rightMid = midpoint(corners.TR, corners.BR);
        return { x: rightMid.x, y: rightMid.y };
      }
      return prev;
    },
    [selectedId, vpId],
  );

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setIsDragging(true);
    setCursorPos({ x: e.clientX, y: e.clientY });

    const currentVpId = vpId; // capture in closure
    let prevTargetVpId: string | null = null;
    const contentEl = getContentRoot();

    const handleMove = (me: PointerEvent) => {
      setCursorPos({ x: me.clientX, y: me.clientY });

      // Use getNodeHitsAtPoint to find elements at cursor position (bridge-compatible)
      const hits = getNodeHitsAtPoint(me.clientX, me.clientY);
      // Find a hit that belongs to a different viewport (variant)
      let foundVpId: string | null = null;
      for (const hit of hits) {
        // vpPrefix format is "vpId-" or "" for desktop
        const hitVpId = hit.vpPrefix ? hit.vpPrefix.replace(/-$/, '') : 'desktop';
        if (hitVpId !== currentVpId) {
          foundVpId = hitVpId;
          break;
        }
      }

      // Also check viewport elements directly for hits on the viewport root itself
      if (!foundVpId) {
        // Fall back to checking viewport rects from nodesMap (top-level nodes represent viewport roots)
        for (const [nodeId, node] of nodes) {
          if (node.parentId || node.isCanvasNode) continue; // only top-level
          const testVpIds = ['desktop', nodeId]; // viewport IDs to try
          for (const testVp of testVpIds) {
            if (testVp === currentVpId) continue;
            const rect = findNodeRect(nodeId, testVp);
            if (rect && me.clientX >= rect.left && me.clientX <= rect.right &&
                me.clientY >= rect.top && me.clientY <= rect.bottom) {
              foundVpId = testVp;
              break;
            }
          }
          if (foundVpId) break;
        }
      }

      if (foundVpId) {
        const variantId = foundVpId === 'desktop' ? 'default' : foundVpId;
        setTargetVariantId(variantId);

        // Source rect = the actual element where the handle was grabbed
        // (variant root OR a child). Target rect = ALWAYS the variant
        // ROOT in the target viewport, even if the user is dragging
        // from / hovering over an equivalent child. Connections
        // semantically target the variant block — never the
        // equivalent replica child.
        const sourceRect = findNodeRect(selectedId!, currentVpId);
        const targetAnchorId = rootNodeId ?? selectedId!;
        const targetRect = findNodeRect(targetAnchorId, foundVpId);
        if (sourceRect && targetRect) {
          const fromQuad = cornersFromRect(sourceRect);
          const toQuad = cornersFromRect(targetRect);
          const fromCenter = quadCenter(fromQuad);
          const toCenter = quadCenter(toQuad);
          const sourceEdge = getClosestEdgeCenterFromQuad(fromQuad, toCenter);
          const targetEdge = getClosestEdgeCenterFromQuad(toQuad, fromCenter);
          const path = generateSteppedPath(sourceEdge.point, targetEdge.point, sourceEdge.dir, targetEdge.dir);
          setDragPath(path);
        }

        // Outline highlights the VARIANT ROOT in the target viewport,
        // matching where the arrow tip lands. Same anchor for cleanup
        // (`prevTargetVpId`) so we don't leave a stale outline on a
        // child node when the user drags away.
        if (prevTargetVpId && prevTargetVpId !== foundVpId && contentEl) {
          const prevPrefix = getViewportPrefix(prevTargetVpId);
          patchNodeStyles(contentEl, targetAnchorId, prevPrefix, { outline: '', outlineOffset: '' });
        }
        if (contentEl) {
          const targetPrefix = getViewportPrefix(foundVpId);
          patchNodeStyles(contentEl, targetAnchorId, targetPrefix, {
            outline: `1px solid ${COMPONENT_COLOR}`,
            outlineOffset: '0px',
          });
        }
        prevTargetVpId = foundVpId;
      } else {
        if (prevTargetVpId && contentEl) {
          const prevPrefix = getViewportPrefix(prevTargetVpId);
          const targetAnchorId = rootNodeId ?? selectedId!;
          patchNodeStyles(contentEl, targetAnchorId, prevPrefix, { outline: '', outlineOffset: '' });
          prevTargetVpId = null;
        }
        setDragPath(null);
        setTargetVariantId(null);
      }
    };

    const handleUp = (me: PointerEvent) => {
      // Use getNodeHitsAtPoint to find target viewport at drop point
      let finalTarget: string | null = null;
      const hits = getNodeHitsAtPoint(me.clientX, me.clientY);
      for (const hit of hits) {
        const hitVpId = hit.vpPrefix ? hit.vpPrefix.replace(/-$/, '') : 'desktop';
        if (hitVpId !== currentVpId) {
          finalTarget = hitVpId === 'desktop' ? 'default' : hitVpId;
          break;
        }
      }

      if (finalTarget) {
        const fromVariant = currentVpId === 'desktop' ? 'default' : currentVpId;
        // sourceNodeId is the data-id of the selected element when the
        // user grabbed the handle. For a variant root that's the root
        // element's data-id, but the codegen treats that case the
        // same as "no sourceNode" (handler lands on the root anyway),
        // so we just pass undefined when the selected node IS a root
        // to avoid pinning the handler to the root's data-id (which
        // would prevent it from moving if the root id changes later).
        const selNode = selectedId ? nodes.get(selectedId) : null;
        // A canvas node has no parentId but is NOT a variant root — it must pass its id as the source so the modal
        // routes to the canvas-node path (data-conn-target). Only a real variant ROOT passes undefined.
        const isRoot = !!selNode && !selNode.parentId && !selNode.isCanvasNode;
        const sourceNodeId = isRoot ? undefined : (selectedId ?? undefined);
        trace.action('connection-handle:drop', { from: fromVariant, to: finalTarget, sourceNodeId });
        onConnectionCreated(fromVariant, finalTarget, { x: me.clientX, y: me.clientY }, sourceNodeId);
      }

      // Clean up outline on the variant root (the same node we
      // outlined during drag — see handleMove above).
      if (prevTargetVpId && contentEl) {
        const prevPrefix = getViewportPrefix(prevTargetVpId);
        const cleanupAnchor = rootNodeId ?? selectedId!;
        patchNodeStyles(contentEl, cleanupAnchor, prevPrefix, { outline: '', outlineOffset: '' });
        prevTargetVpId = null;
      }

      setIsDragging(false);
      setCursorPos(null);
      setDragPath(null);
      setTargetVariantId(null);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  }, [vpId, selectedId, nodes, onConnectionCreated, rootNodeId]);

  if (!shouldShow || !handlePos) return null;

  // Build the drag line path
  let linePath: string | null = null;
  if (isDragging) {
    if (dragPath) {
      // Locked on target — use the same stepped path as permanent arrows
      linePath = dragPath;
    } else if (cursorPos) {
      // Free dragging — simple bezier from handle to cursor
      linePath = `M ${handlePos.x} ${handlePos.y} C ${handlePos.x + 80} ${handlePos.y}, ${cursorPos.x - 80} ${cursorPos.y}, ${cursorPos.x} ${cursorPos.y}`;
    }
  }

  return createPortal(
    <>
      {/* Handle — white circle with purple inner + lightning bolt (matches old builder) */}
      <svg
        onPointerDown={handlePointerDown}
        className="absolute cursor-pointer"
        style={{
          position: 'fixed',
          left: handlePos.x - HANDLE_SIZE / 2,
          top: handlePos.y - HANDLE_SIZE / 2,
          width: HANDLE_SIZE,
          height: HANDLE_SIZE,
          pointerEvents: 'auto',
          zIndex: 3000,
          overflow: 'visible',
        }}
      >
        {/* SVG tooltips come from a <title> CHILD, not a title attribute */}
        <title>Drag to connect variants</title>
        <circle cx="12" cy="12" r="12" fill="white" />
        <circle cx="12" cy="12" r="10" fill={COMPONENT_COLOR} />
        <g transform="translate(12, 12) scale(0.5)">
          <path d="M13.493 3.659a1.25 1.25 0 0 0-.711-1.296a1.195 1.195 0 0 0-1.46.36L3.518 12.736a1.28 1.28 0 0 0-.16 1.302c.172.393.57.741 1.116.741h6.682l-.65 5.562a1.25 1.25 0 0 0 .711 1.296a1.195 1.195 0 0 0 1.46-.36l7.803-10.013a1.28 1.28 0 0 0 .16-1.302a1.22 1.22 0 0 0-1.116-.741h-6.682z" fill="white" transform="translate(-12, -12)" />
        </g>
      </svg>

      {/* Drag line */}
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
            strokeDasharray={targetVariantId ? 'none' : '6 4'}
            strokeLinecap="round"
          />
        </svg>
      )}

    </>,
    document.body,
  );
}
