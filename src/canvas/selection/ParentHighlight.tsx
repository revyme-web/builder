// ParentHighlight.tsx — Dashed accent border drawn around the parent of the
// currently selected element so the user always sees which container they're
// editing inside.
//
// Two activation paths share the same overlay:
//
//   1. Drag — strategies imperatively set the highlight to the would-be drop
//      target via `parentHighlightOps.show(...)`. Lives in the module store.
//   2. Selection — when nothing is overriding the store, we derive the parent
//      from the currently selected node. Makes the highlight appear during
//      plain selection (no drag).
//
// The drag path takes priority — strategies write the exact target they care
// about, which may not be the selected node's parent (e.g. lifted layout
// dragging onto a sibling frame).
//
// Hidden when:
//   - nothing is selected
//   - selection is the page/viewport root (parent is the canvas itself)
//   - text editing is active (the dashed border conflicts with TipTap's caret)
//   - a handle-RESIZE is in flight (the dashed parent border sits right under
//     the resize handles and reads as noise while dragging them — user request
//     2026-07-26). Restored on pointer-up.
//
// Renders an SVG polygon connecting the 4 ROTATED screen corners from the
// bridge's cornersCache, NOT an axis-aligned rect — so the highlight follows
// the parent's actual transformed shape (rotation, skew, etc.). Polls each
// animation frame so pan/zoom/scroll/transform changes stay in sync.

import { useEffect, useSyncExternalStore } from 'react';
import { usePolledValue } from '@/canvas/hooks/usePolledValue';
import { dragStateOps } from '@/canvas/drag/drag-state-store';
import { useAtomValue } from 'jotai';
import { selectedNodeAtom, canvasInteractingAtom } from '@/code/stores/store';
import { useNodesComputed } from '@/code/stores/node-family';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { activeEditorAtom } from '@/code/stores/editor-store';
import { activeFilePathAtom, isIconSetFilePath } from '@/code/project/active-file-store';
import { isComponentFileAtom } from '@/code/stores/store';
import { shapeEditCommitPendingAtom, shapeEditingIdAtom } from '@/code/stores/shape-edit-store';
import { sketchEditingIdAtom } from '@/code/stores/sketch-edit-store';
import { getScreenCornersById, type ScreenCorners } from '@/canvas/resize/geometry-utils';
import { parentHighlightOps, type ParentHighlightInfo } from './parent-highlight-store';
import { dropLineOps } from './drop-line-store';
import { resizeLiveOps } from '@/canvas/resize/resize-live-store';
import { trace } from '@/shared/debug-trace';

// `--selection`, not `--accent`: this dashed outline wraps the user's own
// artwork, so it belongs to the canvas overlay family (selection box, resize
// handles, drop indicators) rather than to the brand chrome.
//
// EXCEPT inside a component master or a TEMPLATE, where the whole overlay family
// turns PURPLE — the colour is the cue that you are editing shared content, not
// one page. Mirrors HoverHighlight (`(isInsideComponent || isComponentInstance)
// ? COMPONENT_COLOR : SELECTION_COLOR`) and SelectionOverlay, which both gate on
// the WIDE `isComponentFileAtom` (= isComponentLikeFilePath: components/ AND
// templates). Using the narrow components-only predicate here was tried before
// and reverted: it left select blue while hover/parent were purple.
const BORDER_COLOR = 'var(--selection)';
const BORDER_COLOR_COMPONENT = 'var(--accent-secondary)';
const BORDER_WIDTH = 1;
const BORDER_DASH = '4 3';

/**
 * Pure helper — derives the parent highlight info to render based on the
 * current selection state. Returns null when nothing should be highlighted
 * (no selection, viewport root selected, drag in progress, or text editing).
 *
 * Exported for unit tests. Component logic mirrors this exactly so any
 * future drift is caught here.
 */
export function deriveSelectionParentHighlight(args: {
  selectedId: string | null;
  nodes: Map<string, { parentId?: string | null }>;
  vpId: string;
  isInteracting: boolean;
  isTextEditing: boolean;
  /** When set (drag is controlling), selection-derived highlight is suppressed. */
  dragInfo: ParentHighlightInfo | null;
  /** A handle-resize gesture is in flight — hide for its duration. */
  isResizing?: boolean;
}): ParentHighlightInfo | null {
  const { selectedId, nodes, vpId, isTextEditing, dragInfo, isResizing } = args;
  if (dragInfo) return null;
  if (isTextEditing) return null;
  // Handle-resize: the dashed border hugs the box the user is dragging the
  // handles of, so it competes with them for exactly the region being
  // manipulated. Hide until pointer-up.
  if (isResizing) return null;
  // We deliberately do NOT bail on `isInteracting`. The drag path takes
  // priority via the `dragInfo ?? selectionInfo` join below, so any drag
  // that wants to OVERRIDE the highlight does so by writing to the
  // store. For drags that DON'T write (e.g. an SVG-group child drag,
  // which keeps the same parent throughout), keeping the selection-
  // derived highlight visible lets the group outline track the dragged
  // child instead of disappearing for the whole gesture.
  if (!selectedId) return null;
  const node = nodes.get(selectedId);
  if (!node) return null;
  // Page/viewport root: parent is the canvas itself, no useful parent rect.
  if (!node.parentId) return null;
  const parent = nodes.get(node.parentId);
  if (!parent) return null;
  return { parentId: node.parentId, vpId };
}

export default function ParentHighlight() {
  // Drag-driven info from the module store (highest priority).
  const dragInfo = useSyncExternalStore(parentHighlightOps.subscribe, parentHighlightOps.get);
  // Layout-drop target: the container the drop-line preview is showing
  // inside (or the empty layout container being hovered). The insertion
  // line says WHERE between siblings the drop lands but not WHICH parent
  // it belongs to — outlining that parent supplies the missing half
  // (user request 2026-08-17). Joined below at drag priority, so the
  // line and the outline appear together; a strategy's explicit
  // `parentHighlightOps.show` still wins when both are set.
  const lineTarget = useSyncExternalStore(dropLineOps.subscribe, dropLineOps.getLayoutDropTarget);
  // Element drag / resize in flight? (dragStateOps covers both.) Used to tell
  // CAMERA interaction apart from element interaction below.
  const isElementDrag = useSyncExternalStore(dragStateOps.subscribe, dragStateOps.get);
  // Handle-resize in flight? `resizeLiveOps` is active between ResizeManager's
  // first pointermove and its pointerup, and notifies on those transitions only
  // (not per frame) — so this costs two re-renders per gesture.
  const isResizing = useSyncExternalStore(resizeLiveOps.subscribe, resizeLiveOps.isResizing);

  const selectedId = useAtomValue(selectedNodeAtom);
  const vpId = useAtomValue(interactingViewportIdAtom);
  const isInteracting = useAtomValue(canvasInteractingAtom);
  const activeEditor = useAtomValue(activeEditorAtom);
  const activeFile = useAtomValue(activeFilePathAtom);
  // WIDE (components/ + templates) — see BORDER_COLOR_COMPONENT above.
  const isInComponentMaster = useAtomValue(isComponentFileAtom);
  // Sketch-edit mode owns its own visual indicator (the dashed accent
  // outline rendered by SketchEditOverlay). The selection-derived
  // parent highlight would draw an outline around the sketch's parent
  // (page root or canvas-root), which is either invisible or
  // distracting — and either way redundant with what the sketch
  // overlay already shows. Bail BEFORE the corner/RAF effects so we
  // don't even pay for the polling.
  const sketchEditingId = useAtomValue(sketchEditingIdAtom);
  // Shape-edit mode: the user is morphing a vector path (dragging
  // anchors / control handles). The dashed group outline competing
  // with the anchor handles around the same shape reads as visual
  // noise — the reference hides the parent indicator while the path is being
  // edited too. Cleared when the user commits or cancels shape edit.
  const shapeEditingId = useAtomValue(shapeEditingIdAtom);
  // Suppress while a source mutation is committing (shape-edit exit OR
  // SVG-group-child drag commit). Cleared on the next renderer
  // `onRenderComplete` once rectCache reflects the new geometry. Without
  // this the dashed border tracks the OLD parent rect for ~1 frame
  // after mouseup, then jumps to the post-refit bounds — visible flicker.
  const overlaySuppressPending = useAtomValue(shapeEditCommitPendingAtom);
  // Icon-set masters: parent of every vector is the master root, which IS
  // the canvas. Highlighting it adds noise (and at root size 0×0 produces
  // a stray dashed segment). Same gate PinConstraintLines uses — see
  // PinConstraintLines.tsx for the long version.
  const isIconSet = isIconSetFilePath(activeFile);

  // Per-computation subscription: the derivation re-runs per commit, but the
  // component only re-renders when the RESULT (parentId/vpId + drag-parent
  // svg-ness) actually changes — an unrelated commit elsewhere no longer
  // wakes this overlay.
  const dragParentId = dragInfo?.parentId ?? null;
  const computed = useNodesComputed((nodes) => ({
    selectionInfo: isIconSet ? null : deriveSelectionParentHighlight({
      selectedId,
      nodes,
      vpId,
      isInteracting,
      isTextEditing: !!activeEditor,
      // A layout-drop preview suppresses the selection-derived outline the
      // same way an explicit strategy write does — only one parent should
      // be outlined while the drag is over a layout target.
      dragInfo: dragInfo ?? lineTarget,
      isResizing,
    }),
    dragParentIsSvg: dragParentId ? nodes.get(dragParentId)?.type === 'svg' : false,
  }), [selectedId, vpId, isInteracting, activeEditor, dragInfo, lineTarget, dragParentId, isIconSet, isResizing]);
  const selectionInfo = computed.selectionInfo;

  // SVG group: keep the dashed group outline VISIBLE during a child drag
  // so the user sees the group expand/contract in real time. This is
  // wired by `bridge-sandbox.ts > patchAttrsAndStyles`, which does an
  // ancestor `emitSubtreeRefresh` whenever a nested-<svg> child's attrs
  // change — keeping the group's `cornersCache` entry fresh every frame
  // the drag's `patchAttrsAndStyles` runs. Without that ancestor walk,
  // the dashed outline would stay frozen at the pre-drag fit, which is
  // why this branch USED to null out `dragInfo` for SVG-group parents.
  // (dragParentIsSvg comes from the useNodesComputed above.)
  const info = dragInfo ?? lineTarget ?? selectionInfo;
  // Depend on primitives, not object identity. `selectionInfo` is rebuilt
  // every render (deriveSelectionParentHighlight returns a fresh object), so
  // depending on `info` directly retriggers the effect on every render →
  // setCorners → re-render → fresh info → effect again → "Maximum update
  // depth exceeded".
  const infoParentId = info?.parentId ?? null;
  const infoVpId = info?.vpId ?? null;
  // The thick/solid "drag" style is meant for reparent-target hovers —
  // it signals "drop here". SVG group children never get reparented
  // during drag (they just move inside their group), so the thicker
  // look reads as wrong noise; render them with the thin dashed
  // selection look instead.
  const isSvgGroupDrag = !!dragInfo && computed.dragParentIsSvg;
  const isDragSource = (!!dragInfo && !isSvgGroupDrag) || (!dragInfo && !!lineTarget);
  // Mount/unmount traces — same guard + deps as the poll below, declared
  // FIRST so the mount trace fires before the poll starts (original order).
  useEffect(() => {
    if (!infoParentId || !infoVpId) return;
    trace.action('parent-highlight:mount', {
      parentId: infoParentId,
      source: isDragSource ? 'drag' : 'selection',
    });
    return () => {
      trace.action('parent-highlight:unmount');
    };
  }, [infoParentId, infoVpId, isDragSource]);

  // RAF poll so the rect tracks pan/zoom/resize and any transform changes
  // on the parent (e.g. parent rotation animating during a transition).
  // PAN/ZOOM: `canvasInteracting` without an element drag = the camera is
  // moving. Every other selection helper hides for the gesture; the dashed
  // parent outline stayed visible (its deliberate keep-during-DRAG rule was
  // too broad) and kept polling corners per frame. Disable BOTH the poll and
  // the render for camera moves; element drags/resizes keep the outline
  // exactly as before.
  const isCameraMove = isInteracting && !isElementDrag && !dragInfo;
  // SVG-group child drag: the group's DOM box only re-fits at COMMIT — a
  // per-tick DOM refit feeds back into the drag's coordinate math (the box's
  // left/top is the frame the child positions are computed in; live-sliding
  // it ran the viewBox away and froze the drag, 2026-07-28). The dashed
  // outline therefore expands at the OVERLAY level instead: the polygon is
  // the UNION of the group box and the dragged child's box — pure screen
  // math from cornersCache (which the bridge's per-tick attr patch keeps
  // fresh via its ancestor subtree refresh).
  const dragChildId = isSvgGroupDrag ? selectedId : null;
  const corners = usePolledValue<ScreenCorners>(
    !!(infoParentId && infoVpId) && !isCameraMove && !isResizing,
    () => {
      const g = getScreenCornersById(infoParentId!, infoVpId!);
      if (!g || !dragChildId) return g;
      const c = getScreenCornersById(dragChildId, infoVpId!);
      if (!c) return g;
      const xs = [g.TL.x, g.TR.x, g.BR.x, g.BL.x, c.TL.x, c.TR.x, c.BR.x, c.BL.x];
      const ys = [g.TL.y, g.TR.y, g.BR.y, g.BL.y, c.TL.y, c.TR.y, c.BR.y, c.BL.y];
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      return { TL: { x: minX, y: minY }, TR: { x: maxX, y: minY }, BR: { x: maxX, y: maxY }, BL: { x: minX, y: maxY } };
    },
    [infoParentId, infoVpId, isDragSource, dragChildId],
    { immediate: true },
  );

  // Guard `info` too — there's a one-render window where the parent
  // highlight clears (selection released, drag ended) BUT the RAF poll
  // has already committed `corners` from the previous tick. Without this,
  // the JSX below reads `info.parentId` on null and crashes. The corners
  // effect cleans up on the next tick, but React renders with the
  // stale state in between.
  // Gates the DRAG-driven info too — a strategy could still be holding the
  // store when a resize starts. The corner poll above is disabled for the same
  // condition, so the gesture costs no per-frame work here.
  if (isResizing) return null;
  if (isCameraMove) return null;
  if (!corners || !info) return null;
  if (overlaySuppressPending) return null;
  if (sketchEditingId) return null;
  // Hide the dashed parent outline entirely while in shape-edit mode — the
  // anchor/vertex handles are the focus, and the group border competes with
  // them as visual noise (including when editing a child of an SVG group).
  if (shapeEditingId) return null;

  // Polygon path connecting the 4 rotated screen corners. SVG covers the
  // full viewport (matches SelectionBorder's pattern); coordinates are in
  // screen space so no transform on the SVG itself is needed.
  const points = `${corners.TL.x},${corners.TL.y} ${corners.TR.x},${corners.TR.y} ${corners.BR.x},${corners.BR.y} ${corners.BL.x},${corners.BL.y}`;

  return (
    <svg
      data-parent-highlight=""
      data-parent-id={info.parentId}
      data-source={isDragSource ? 'drag' : 'selection'}
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: 1,
        overflow: 'visible',
      }}
    >
      <polygon
        points={points}
        fill="none"
        stroke={isInComponentMaster ? BORDER_COLOR_COMPONENT : BORDER_COLOR}
        // Drag-driven highlight: thicker (1.5) + solid + non-scaling
        // stroke + full opacity — same look as HoverHighlight so the
        // user gets the same visual weight as a node-hover when the
        // drag is over its target parent. Selection-derived highlight
        // keeps the thin (1) dashed look so it doesn't compete with
        // the SelectionBorder around the selected node.
        strokeWidth={isDragSource ? 1.5 : BORDER_WIDTH}
        strokeDasharray={isDragSource ? undefined : BORDER_DASH}
        vectorEffect={isDragSource ? 'non-scaling-stroke' : undefined}
        opacity={isDragSource ? 1 : 0.7}
      />
    </svg>
  );
}
