// ResizeManager.ts — Handles pointer-driven element resizing.
// Transform compensation ported from old builder's create-resize-handler.tsx.
// Follows imperative-first pattern: DOM updates instantly, code catches up.

import type { Direction } from './geometry-utils';
import { isComponentFilePath, isIconSetFilePath, isVectorSetComponentFile } from '@/code/project/active-file-store';
import { parseIconSetConfig, iconConfigPx } from '@/code/icons/icon-set-config';
import { updateIconPosition, updateIconSize } from '@/code/icons/icon-set-ops';
import { projectFS } from '@/code/project/project-fs';
import { syncQueueCode, queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { bakeStylesForTile, tileContextFor } from '@/canvas/replica-bake';
import { getViewportWidths } from '@/code/stores/viewport-store';
import { dragStateOps } from '@/canvas/drag/drag-state-store';
import { getActiveFilePath, findNodeRect, findNodeComputedStyles, patchNodeStyles, getViewportPrefix, updateNodeStyles, findSvgShapeChild, getSvgGroupAncestorChain, isPrimaryViewport, forceCanvasRender } from '@/canvas/node-ops';
import { viewportBandPinOps } from './viewport-band-pin-store';
import { normalizeGroupOnResize, refitGroupChain } from '@/code/svg/refit-group';
import {
  getHandlesFromDirection,
  getOppositeCorner,
  getHierarchicalInverseTransformedResizeDeltaById,
  processZeroCrossing,
  updateDirectionAfterCrossing,
  getScreenCornersById,
} from './geometry-utils';
import { buildParentScreenMap, buildParentSvgGroupMap } from '@/canvas/creators/creator-utils';
import { groupChildrenCarryVariantGeometry, compensateGroupChildVariantsForBaseBox } from '@/canvas/drag/replica-context';
import { parseSvgRotate, mergeSvgRotate, parseRotationFromMatrix } from './RotateManager';
import { shapeEditCommitPendingAtom } from '@/code/stores/shape-edit-store';
import { computeOverlayPosition } from '@/canvas/renderer/overlay-portals';
import { isOverlayNode, resolveOverlayConfig } from '@/code/parsing/overlay-parser';
import { beginOverlayFollow, updateOverlayFollow, endOverlayFollow } from '@/canvas/drag/overlay-follow';
import { visibleViewportsAtom } from '@/code/stores/viewport-store';
import type { OverlayConfig, NodeMap } from '@/shared/types';
import { scaleShapeGeometry, GEOMETRY_ATTRS_BY_TAG } from '@/shared/svg-geometry';
import { getTransformedPoint } from '@/canvas/canvas-math';
import { transformManager } from '@/canvas/transform';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { styleHelperOps } from '@/canvas/selection/style-helper-store';
import { resizeLiveOps } from '@/canvas/resize/resize-live-store';
import { getInsetState } from '@/shared/pin-utils';
import { trace } from '@/shared/debug-trace';
import { getNodeFromCache, injectNodeIntoCache } from '@/code/stores/store';
import { findChildRects, getContentRootRect } from '@/canvas/node-ops';
import { getAbsoluteCanvasRectById, getParentCanvasOffsetById } from '@/canvas/canvas-math';
import type { SnapGuide, Transform } from '@/shared/types';
import { SNAP_THRESHOLD } from '@/shared/constants';
import { getActiveRulerGuideSnapLines } from '@/code/stores/ruler-guides-store';
import { nodesAtom } from '@/code/stores/store';
import { viewportsConfigAtom, viewportWidthsAtom } from '@/code/stores/viewport-store';
import { getAllCachedNodes } from '@/code/stores/store';
import { containerOverridesAtom } from '@/code/stores/container-query-store';
import { getDefaultStore } from 'jotai';
import { collectTopLevelSnapTargets } from '@/canvas/snap-targets';
import { beginViewportUnitLivePatch } from './viewport-width-scrub';

const MIN_SIZE = 1;

/** Collect sibling + parent-frame rects in canvas-space. Shared between the
 *  axis-aligned snap path and the transformed snap path.
 *
 *  When `parentId` is null the moving element is a top-level node
 *  (canvas-node, variant root, container-set variant card). In that
 *  case we delegate to `collectTopLevelSnapTargets` which walks every
 *  parentless rect-cache entry — same logic the drag-side
 *  `CanvasDragStrategy` uses for top-level drags, so resize and drag
 *  see the same set of snap candidates. */
/** Top-level (parentless) ancestor — an overlay's positioning origin (a page's
 *  `root`, a component's variant-root element id). Used by the live overlay
 *  resize so component overlays grow alignment-correctly. */
function overlayTopLevelAncestor(nodeId: string, nodes: NodeMap): string {
  let cur = nodes.get(nodeId);
  const seen = new Set<string>();
  while (cur && cur.parentId && !seen.has(cur.id)) {
    seen.add(cur.id);
    const next = nodes.get(cur.parentId);
    if (!next) break;
    cur = next;
  }
  return cur?.id ?? nodeId;
}

function collectResizeSiblings(
  parentId: string | null, nodeId: string, vpId: string, transform: Transform,
): Array<{ id: string; rect: { left: number; top: number; width: number; height: number } }> {
  if (!parentId) {
    const nodes = getDefaultStore().get(nodesAtom);
    const movingPrefix = getViewportPrefix(vpId);
    return collectTopLevelSnapTargets(new Set([nodeId]), movingPrefix, transform, nodes);
  }
  const nodesForOverlay = getDefaultStore().get(nodesAtom);
  const siblings: Array<{ id: string; rect: { left: number; top: number; width: number; height: number } }> = [];
  for (const child of findChildRects(parentId, vpId)) {
    if (child.id === nodeId) continue;
    if (isOverlayNode(nodesForOverlay.get(child.id))) continue; // overlays aren't snap targets
    const ar = getAbsoluteCanvasRectById(child.id, vpId, transform);
    if (ar) siblings.push({ id: child.id, rect: ar });
  }
  const parentAbs = getAbsoluteCanvasRectById(parentId, vpId, transform);
  if (parentAbs) siblings.push({ id: `${parentId}__frame`, rect: parentAbs });
  return siblings;
}

/** Find closest snap target on an axis (edge or center) within threshold. */
function findClosestEdge(
  pos: number, axis: 'x' | 'y',
  siblings: Array<{ id: string; rect: { left: number; top: number; width: number; height: number } }>,
  threshold: number,
): { snapped: number; guide: SnapGuide } | null {
  let bestDist = threshold, bestPos = pos, bestRef = '', bestType: 'edge' | 'center' = 'edge';
  for (const sib of siblings) {
    const targets = axis === 'x'
      ? [sib.rect.left, sib.rect.left + sib.rect.width / 2, sib.rect.left + sib.rect.width]
      : [sib.rect.top, sib.rect.top + sib.rect.height / 2, sib.rect.top + sib.rect.height];
    const types: Array<'edge' | 'center'> = ['edge', 'center', 'edge'];
    for (let i = 0; i < targets.length; i++) {
      const d = Math.abs(pos - targets[i]);
      if (d < bestDist) { bestDist = d; bestPos = targets[i]; bestRef = sib.id; bestType = types[i]; }
    }
  }
  if (!bestRef) return null;
  return { snapped: bestPos, guide: { axis, position: bestPos, type: bestType, referenceId: bestRef } };
}

/** Parse `matrix(a, b, c, d, e, f)` → 2x2 rotation/scale [a, b, c, d].
 *  Returns null if not parseable. */
function parseMatrix2D(matrixStr: string): { a: number; b: number; c: number; d: number } | null {
  const m = matrixStr.match(/matrix\(([-\d.e+]+),\s*([-\d.e+]+),\s*([-\d.e+]+),\s*([-\d.e+]+),\s*([-\d.e+]+),\s*([-\d.e+]+)\)/);
  if (!m) return null;
  return { a: parseFloat(m[1]), b: parseFloat(m[2]), c: parseFloat(m[3]), d: parseFloat(m[4]) };
}

/** Snap resize for a transformed (rotated/skewed) element.
 *
 *  Math model:
 *    The resize fixedPoint is the visual position of the LAYOUT corner
 *    opposite the active handle. After transform compensation runs, this
 *    visual fixedPoint stays exactly where it started. The visual MOVING
 *    point (corner being pulled) is then:
 *
 *        visualMoving = fixedPoint + R · (signX·W, signY·H)
 *
 *    where R is the 2x2 transform matrix [a c; b d] and (signX, signY)
 *    encode which corner the handle is pulling (e.g. 'right' → signX=+1
 *    signY=0, 'topRight' → +1, -1, 'bottomLeft' → -1, +1).
 *
 *    To snap visualMoving.x onto a sibling target Tx (with current H held):
 *        Tx = fixedPoint.x + a·signX·W + c·signY·H
 *        →   W = (Tx - fixedPoint.x - c·signY·H) / (a·signX)
 *
 *    Symmetric for y onto Ty (solving for H).
 *
 *    For edge handles one of signX/signY is 0, so the corresponding term
 *    drops out — the snap is well-defined and only modifies the active
 *    dimension. For corner handles we hold the inactive dimension (cursor's
 *    current value) and solve the active dimension that satisfies the snap.
 *
 *  Returns the snap-adjusted W/H and any guides. The transform-compensation
 *  step that runs right after re-pins the visual fixedPoint, so the visual
 *  moving point lands exactly on the snap target. */
function snapResizeRotated(
  newL: number, newT: number, newW: number, newH: number,
  xHandle: 'left' | 'right' | null, yHandle: 'top' | 'bottom' | null,
  fixedPointParentRel: { x: number; y: number },
  matrixStr: string,
  nodeId: string, vpId: string, parentId: string | null,
  transform: Transform,
): { width: number; height: number; guides: SnapGuide[] } {
  void newL; void newT; // included for signature parity / future use
  const guides: SnapGuide[] = [];
  const mat = parseMatrix2D(matrixStr);
  if (!mat) return { width: newW, height: newH, guides };

  // Diagonal direction in layout-space from fixedPoint to moving point.
  const signX = xHandle === 'right' ? 1 : xHandle === 'left' ? -1 : 0;
  const signY = yHandle === 'bottom' ? 1 : yHandle === 'top' ? -1 : 0;
  if (signX === 0 && signY === 0) return { width: newW, height: newH, guides };

  // Lift fixedPoint to canvas-space for sibling matching. Canvas nodes
  // have no parent — their fixedPoint is already in canvas-space, so
  // the offset collapses to zero.
  const parentOffset = parentId
    ? getParentCanvasOffsetById(parentId, vpId, transform)
    : { x: 0, y: 0 };
  const fxC = fixedPointParentRel.x + parentOffset.x;
  const fyC = fixedPointParentRel.y + parentOffset.y;

  // Current visual moving point in canvas-space.
  const layoutDx = signX * newW;
  const layoutDy = signY * newH;
  const vMx = fxC + mat.a * layoutDx + mat.c * layoutDy;
  const vMy = fyC + mat.b * layoutDx + mat.d * layoutDy;

  const siblings = collectResizeSiblings(parentId, nodeId, vpId, transform);
  const rulerGuides = getActiveRulerGuideSnapLines();
  if (siblings.length === 0 && rulerGuides.length === 0) {
    return { width: newW, height: newH, guides };
  }

  const threshold = SNAP_THRESHOLD / transform.scale;

  // Each candidate snap stores the dim delta it would apply + the visual
  // distance from current visualMoving (so we can rank by closeness).
  type Cand = { deltaW: number; deltaH: number; dist: number; guide: SnapGuide };
  const xCands: Cand[] = [];
  const yCands: Cand[] = [];

  // Try snapping visualMoving.x onto target Tx — modifies W when signX !== 0.
  // Use current H as the held value (no change to H from x-snap).
  const tryX = (Tx: number, ref: string, type: 'edge' | 'center') => {
    if (signX === 0) return;
    const denomX = mat.a * signX;
    if (Math.abs(denomX) < 0.01) return; // x of visualMoving doesn't depend on W (e.g. 90° rotation)
    const newW_x = (Tx - fxC - mat.c * signY * newH) / denomX;
    if (newW_x < 1) return;
    // Predicted visualMoving with new W, current H.
    const predY = fyC + mat.b * signX * newW_x + mat.d * signY * newH;
    const dist = Math.hypot(vMx - Tx, vMy - predY);
    if (dist > threshold) return;
    xCands.push({
      deltaW: newW_x - newW, deltaH: 0, dist,
      guide: { axis: 'x', position: Tx, type, referenceId: ref },
    });
  };

  // Symmetric Y snap — modifies H. Holds current W.
  const tryY = (Ty: number, ref: string, type: 'edge' | 'center') => {
    if (signY === 0) return;
    const denomY = mat.d * signY;
    if (Math.abs(denomY) < 0.01) return;
    const newH_y = (Ty - fyC - mat.b * signX * newW) / denomY;
    if (newH_y < 1) return;
    const predX = fxC + mat.a * signX * newW + mat.c * signY * newH_y;
    const dist = Math.hypot(vMx - predX, vMy - Ty);
    if (dist > threshold) return;
    yCands.push({
      deltaW: 0, deltaH: newH_y - newH, dist,
      guide: { axis: 'y', position: Ty, type, referenceId: ref },
    });
  };

  for (const sib of siblings) {
    const sL = sib.rect.left, sR = sL + sib.rect.width, sCX = sL + sib.rect.width / 2;
    const sT = sib.rect.top, sB = sT + sib.rect.height, sCY = sT + sib.rect.height / 2;
    tryX(sL, sib.id, 'edge');
    tryX(sR, sib.id, 'edge');
    tryX(sCX, sib.id, 'center');
    tryY(sT, sib.id, 'edge');
    tryY(sB, sib.id, 'edge');
    tryY(sCY, sib.id, 'center');
  }

  // Persistent ruler guides — single canvas-space line per guide. Same
  // tryX/tryY math as siblings; the active handle's axis decides which
  // call applies (the helpers no-op when `signX`/`signY` is 0).
  for (const g of rulerGuides) {
    const ref = `ruler-guide:${g.id}`;
    if (g.axis === 'x') tryX(g.position, ref, 'edge');
    else tryY(g.position, ref, 'edge');
  }

  // Pick best per axis (closest visual distance).
  const bestX = xCands.length ? xCands.reduce((a, b) => a.dist < b.dist ? a : b) : null;
  const bestY = yCands.length ? yCands.reduce((a, b) => a.dist < b.dist ? a : b) : null;

  let snappedW = newW, snappedH = newH;
  if (bestX) { snappedW += bestX.deltaW; guides.push(bestX.guide); }
  if (bestY) { snappedH += bestY.deltaH; guides.push(bestY.guide); }

  return { width: Math.max(1, snappedW), height: Math.max(1, snappedH), guides };
}

/** Snap resizing edges against sibling rects + parent inner walls.
 *  Operates entirely in canvas-space — same coordinate system the drag
 *  strategies use via `getAbsoluteCanvasRectById` / `getParentCanvasOffsetById`.
 *  This avoids the parent-relative math drift seen at non-1 zoom levels.
 *
 *  Inputs (`newLeft/newTop/newWidth/newHeight`) are in parent-relative CSS
 *  pixels (the resize coordinate system). We add the parent's canvas offset
 *  to lift into canvas-space, snap there, then subtract it back. */
function snapResizeEdges(
  newLeft: number, newTop: number, newWidth: number, newHeight: number,
  xHandle: 'left' | 'right' | null, yHandle: 'top' | 'bottom' | null,
  nodeId: string, vpId: string, parentId: string | null,
  transform: Transform,
): { left: number; top: number; width: number; height: number; guides: SnapGuide[] } {
  const guides: SnapGuide[] = [];
  let snapLeft = newLeft, snapTop = newTop, snapWidth = newWidth, snapHeight = newHeight;

  // Threshold in CSS px; SNAP_THRESHOLD is in screen px. Both forms are valid
  // since snap math operates in canvas-space (same units as canvas-dnd).
  const threshold = SNAP_THRESHOLD / transform.scale;

  // Lift to canvas-space. When the node has a parent, add its canvas
  // offset; canvas nodes are already in canvas-space (no parent → zero
  // offset) so the math collapses to identity for them.
  const parentOffset = parentId
    ? getParentCanvasOffsetById(parentId, vpId, transform)
    : { x: 0, y: 0 };
  const absLeft = snapLeft + parentOffset.x;
  const absTop = snapTop + parentOffset.y;

  // Sibling rects in canvas-space (matches drag-strategy math exactly).
  // For canvas nodes (parentId === null) the shared
  // `collectTopLevelSnapTargets` walk fires inside the helper.
  const siblings = collectResizeSiblings(parentId, nodeId, vpId, transform);
  // Persistent ruler guides — additional canvas-space snap targets. Each
  // guide is a single line on its axis; for resize we treat it like a
  // sibling edge (no center/secondary positions). Read once per resize
  // cycle so the cost is constant in the number of guides.
  const rulerGuides = getActiveRulerGuideSnapLines();

  if (siblings.length === 0 && rulerGuides.length === 0) {
    return { left: snapLeft, top: snapTop, width: snapWidth, height: snapHeight, guides };
  }

  // Find closest sibling-edge / ruler-guide for a canvas-space position
  // on an axis. Ruler-guide refIds carry the `ruler-guide:` prefix so
  // overlay rendering can tell them apart from sibling-edge guides.
  const findSnap = (pos: number, axis: 'x' | 'y'): { snapped: number; guide: SnapGuide } | null => {
    let bestDist = threshold, bestPos = pos, bestRef = '', bestType: 'edge' | 'center' = 'edge';
    for (const sib of siblings) {
      const targets = axis === 'x'
        ? [sib.rect.left, sib.rect.left + sib.rect.width / 2, sib.rect.left + sib.rect.width]
        : [sib.rect.top, sib.rect.top + sib.rect.height / 2, sib.rect.top + sib.rect.height];
      const types: Array<'edge' | 'center'> = ['edge', 'center', 'edge'];
      for (let i = 0; i < targets.length; i++) {
        const d = Math.abs(pos - targets[i]);
        if (d < bestDist) { bestDist = d; bestPos = targets[i]; bestRef = sib.id; bestType = types[i]; }
      }
    }
    for (const g of rulerGuides) {
      if (g.axis !== axis) continue;
      const d = Math.abs(pos - g.position);
      if (d < bestDist) { bestDist = d; bestPos = g.position; bestRef = `ruler-guide:${g.id}`; bestType = 'edge'; }
    }
    if (!bestRef) return null;
    return { snapped: bestPos, guide: { axis, position: bestPos, type: bestType, referenceId: bestRef } };
  };

  // Snap each active edge in canvas-space; the `snapped` value is canvas-space,
  // so apply the delta to the parent-relative `snapLeft`/`snapTop` to keep them
  // consistent. Guides keep canvas-space positions for the overlay.
  if (xHandle === 'right') {
    const s = findSnap(absLeft + snapWidth, 'x');
    if (s) { snapWidth = s.snapped - absLeft; guides.push(s.guide); }
  }
  if (xHandle === 'left') {
    const s = findSnap(absLeft, 'x');
    if (s) { const delta = s.snapped - absLeft; snapWidth -= delta; snapLeft += delta; guides.push(s.guide); }
  }
  if (yHandle === 'bottom') {
    const s = findSnap(absTop + snapHeight, 'y');
    if (s) { snapHeight = s.snapped - absTop; guides.push(s.guide); }
  }
  if (yHandle === 'top') {
    const s = findSnap(absTop, 'y');
    if (s) { const delta = s.snapped - absTop; snapHeight -= delta; snapTop += delta; guides.push(s.guide); }
  }

  return { left: snapLeft, top: snapTop, width: snapWidth, height: snapHeight, guides };
}

interface ResizeCallbacks {
  contentEl: HTMLElement;
  nodeId: string;
  onInteracting: (active: boolean) => void;
  /** Called when a viewport root is resized — updates viewport config
   *  instead of writing @container width / inline JSX height.
   *  `newWidth` reflects the final px width (always passed for vp resizes).
   *  `newHeight` is the final px height; the consumer should treat it as
   *  "set fixed-px viewport height" only when the user explicitly opted into
   *  px-mode. Pass `0` to leave viewport height untouched (auto). */
  onViewportResize?: (vpId: string, newWidth: number, newHeight?: number, newX?: number) => void;
  /** Called when a variant root is resized — updates variantConfig position (x, y). */
  onVariantPositionUpdate?: (variantName: string, x: number, y: number) => void;
  /** Live snap-guide overlay updates during resize. Empty array on miss. */
  onSnapGuidesChange?: (guides: SnapGuide[]) => void;
}

/**
 * Parse the unit suffix from a CSS dimension value.
 * '100vh' → 'vh', '50%' → '%', '320px' → 'px', 'auto'/'min-content' → 'px'
 * (no numeric value ⇒ treated as px so the resize commits a px size).
 */
export function parseDimUnit(value: string | undefined): string {
  const m = value?.trim().match(/^-?[\d.]+\s*([a-z%]+)\s*$/i);
  return m ? m[1].toLowerCase() : 'px';
}

/**
 * Format a resized pixel dimension back into the element's ORIGINAL unit so a
 * resize stays in-unit and stable (was reverting to px on mouse-up).
 *
 * - `%`              → parent-relative (needs `parentCss > 0`), integer.
 * - vh/vw/rem/em/cqh… → reuse the element's OWN start px↔unit ratio (`pxPerUnit`,
 *   measured at drag start). These units are independent of the element's own
 *   size during a gesture, so the ratio is constant and the conversion exact.
 *   Rounded to integer (matches the `%` path and the dimensions tooltip).
 * - anything else / missing ratio → px (via the caller's `pxFormat`, which keeps
 *   the rotated-element 3-decimal vs un-rotated integer behaviour identical).
 */
export function formatResizeDimension(
  newPx: number,
  unit: string,
  pxPerUnit: number,
  parentCss: number,
  pxFormat: (n: number) => string,
): string {
  if (unit === '%') return parentCss > 0 ? `${Math.round((newPx / parentCss) * 100)}%` : pxFormat(newPx);
  if (unit !== 'px' && pxPerUnit > 0) return `${Math.round(newPx / pxPerUnit)}${unit}`;
  return pxFormat(newPx);
}

/**
 * Resolve a CSS position value (px, %, or opposite-side inset) to an absolute pixel value.
 * Used to compute startLeft/startTop from CSS properties (NOT getBoundingClientRect
 * which gives wrong values for rotated elements).
 *
 * @param styleProp - The CSS property value (e.g. '100px', '50%', undefined)
 * @param oppProp - The opposite-side CSS property (e.g. 'right' when resolving 'left')
 * @param size - The element's size on this axis (width or height)
 * @param parentSize - The parent's size on this axis
 * @param transform - The element's CSS transform string
 * @param axis - Which axis ('x' or 'y')
 * @param fallback - Fallback value when no CSS property is set (e.g. el.offsetLeft)
 */
export function resolvePos(
  styleProp: string | undefined,
  oppProp: string | undefined,
  size: number,
  parentSize: number,
  transform: string,
  axis: 'x' | 'y',
  fallback: number = 0,
): number {
  if (styleProp?.includes('px')) return parseFloat(styleProp) || 0;
  if (styleProp?.includes('%')) {
    let pos = (parseFloat(styleProp) / 100) * parentSize;
    // Compensate for translate centering
    if (axis === 'x' && (transform.includes('translateX(-50%)') || transform.includes('translate(-50%'))) pos -= size / 2;
    if (axis === 'y' && (transform.includes('translateY(-50%)') || transform.includes('translate(-50%, -50%)') || transform.includes('translate(-50%,-50%)'))) pos -= size / 2;
    return pos;
  }
  if (oppProp?.includes('px')) return parentSize - (parseFloat(oppProp) || 0) - size;
  return fallback;
}

/**
 * Calculate new dimensions and position from a resize delta.
 * Pure math — no DOM access.
 */
export function calculateResizeDelta(
  curWidth: number, curHeight: number,
  curLeft: number, curTop: number,
  deltaX: number, deltaY: number,
  xHandle: 'left' | 'right' | null,
  yHandle: 'top' | 'bottom' | null,
  isInLayout: boolean,
): { width: number; height: number; left: number; top: number } {
  let newWidth = curWidth;
  let newHeight = curHeight;
  let newLeft = curLeft;
  let newTop = curTop;

  if (isInLayout) {
    if (xHandle === 'left') newWidth = curWidth - deltaX;
    else if (xHandle === 'right') newWidth = curWidth + deltaX;
    if (yHandle === 'top') newHeight = curHeight - deltaY;
    else if (yHandle === 'bottom') newHeight = curHeight + deltaY;
  } else {
    if (xHandle === 'left') {
      newWidth = curWidth - deltaX;
      newLeft = curLeft + deltaX;
    } else if (xHandle === 'right') {
      newWidth = curWidth + deltaX;
    }
    if (yHandle === 'top') {
      newHeight = curHeight - deltaY;
      newTop = curTop + deltaY;
    } else if (yHandle === 'bottom') {
      newHeight = curHeight + deltaY;
    }
  }

  return { width: newWidth, height: newHeight, left: newLeft, top: newTop };
}

/**
 * Apply aspect ratio lock to resize dimensions.
 * When Shift is held on a corner resize, height is derived from width.
 */
export function applyAspectRatioLock(
  newWidth: number, newHeight: number,
  curHeight: number, curTop: number,
  aspectRatio: number,
  yHandle: 'top' | 'bottom' | null,
  isInLayout: boolean,
): { width: number; height: number; top: number } {
  const lockedHeight = newWidth / aspectRatio;
  let newTop = curTop; // preserve curTop by default for non-top-handle cases
  if (yHandle === 'top' && !isInLayout) {
    newTop = curTop + (curHeight - lockedHeight);
  }
  return { width: newWidth, height: lockedHeight, top: newTop };
}

/**
 * FORCED aspect-ratio lock for a VECTOR SET instance (icon / vector), on ANY
 * handle — the reference behaviour: a vector set always keeps its aspect ratio, so
 * dragging any handle scales width AND height together (you can't distort it).
 *  - Corner: width drives height; the opposite corner stays pinned (top handle
 *    moves top, like Shift-lock).
 *  - Horizontal edge (left/right): width drives height; the height change is
 *    SYMMETRIC so the un-dragged axis stays centred.
 *  - Vertical edge (top/bottom): height drives width; the width change is
 *    symmetric.
 * Position re-anchoring is skipped for layout-flow children (the parent layout
 * positions them — only width/height matter); absolute elements re-anchor via
 * left/top.
 */
export function applyVectorAspectLock(
  newWidth: number, newHeight: number,
  curWidth: number, curHeight: number, curLeft: number, curTop: number,
  aspectRatio: number,
  xHandle: 'left' | 'right' | null,
  yHandle: 'top' | 'bottom' | null,
  isInLayout: boolean,
): { width: number; height: number; left: number; top: number } {
  if (!(aspectRatio > 0)) return { width: newWidth, height: newHeight, left: curLeft, top: curTop };
  // Vertical edge only → height drives width (symmetric in x).
  if (yHandle && !xHandle) {
    const w = newHeight * aspectRatio;
    const left = isInLayout ? curLeft : curLeft - (w - curWidth) / 2;
    return { width: w, height: newHeight, left, top: curTop };
  }
  // Corner OR horizontal edge → width drives height.
  const h = newWidth / aspectRatio;
  let top = curTop;
  if (xHandle && !yHandle) {
    top = isInLayout ? curTop : curTop - (h - curHeight) / 2;   // horizontal edge: symmetric in y
  } else if (yHandle === 'top' && !isInLayout) {
    top = curTop + (curHeight - h);                              // corner, top handle: pin bottom
  }
  return { width: newWidth, height: h, left: curLeft, top };
}

/**
 * Shift-on-corner aspect lock for the CUSTOM SVG resize loops (rotated shape /
 * rotated group), which bypass startResize's shared `applyAspectRatioLock`.
 * Width drives height — identical semantics to the shared helper; the loops'
 * opposite-corner pin re-anchors left/top from the locked dims, so only the
 * height needs deriving. Returns the (possibly locked) height.
 */
export function lockedShiftHeight(
  width: number, height: number,
  shiftHeld: boolean,
  xHandle: 'left' | 'right' | null,
  yHandle: 'top' | 'bottom' | null,
  ratio: number,
): number {
  if (!shiftHeld || !xHandle || !yHandle || !(ratio > 0)) return height;
  return Math.max(MIN_SIZE, width / ratio);
}

/**
 * Apply symmetric ("resize from centre") sizing — the Alt-resize behaviour.
 * A normal resize keeps the OPPOSITE edge pinned; Alt keeps the CENTRE
 * pinned. Given the normal resize result, this doubles the per-side size
 * change and shifts left/top back by one delta so the centre stays fixed.
 */
export function applySymmetricResize(
  curWidth: number, curHeight: number, curLeft: number, curTop: number,
  newWidth: number, newHeight: number,
): { width: number; height: number; left: number; top: number } {
  const dW = newWidth - curWidth;
  const dH = newHeight - curHeight;
  return {
    width: curWidth + dW * 2,
    height: curHeight + dH * 2,
    left: curLeft - dW,
    top: curTop - dH,
  };
}

/**
 * Determine which CSS properties to commit after resize, based on pin state.
 */
export function getResizeCommitProperties(
  styles: { width: string; height: string; left: string; right: string; top: string; bottom: string },
  pins: { left: boolean; right: boolean; top: boolean; bottom: boolean },
  isInLayout: boolean,
  isFixedLeft: boolean,
  isFixedTop: boolean,
  horizontalInset: boolean,
  verticalInset: boolean,
  isVariantRoot: boolean,
  direction?: string,
  /** The live loop re-aimed this axis' % position (centered `left: N%` +
   *  translate -50% form, or the plain-% edge form) — commit it or the
   *  opposite edge drifts on mouse-up. Caller-computed from what was
   *  ACTUALLY written: with a transform, even a vertical-only drag moves x
   *  (rotation coupling), so this is NOT derivable from `direction`. */
  centeredX: boolean = false,
  centeredY: boolean = false,
): Record<string, string> {
  const finalStyles: Record<string, string> = {};

  // Only include dimensions that were actually resized.
  // Edge drags (left/right) only change width; (top/bottom) only change height.
  // Corner drags change both.
  const changedH = !direction || direction.includes('left') || direction.includes('right') ||
    direction.includes('Left') || direction.includes('Right') ||
    direction === 'topLeft' || direction === 'topRight' || direction === 'bottomLeft' || direction === 'bottomRight';
  const changedV = !direction || direction.includes('top') || direction.includes('bottom') ||
    direction.includes('Top') || direction.includes('Bottom') ||
    direction === 'topLeft' || direction === 'topRight' || direction === 'bottomLeft' || direction === 'bottomRight';

  if (changedH) finalStyles.width = styles.width;
  if (changedV) finalStyles.height = styles.height;

  if (!isInLayout) {
    if (pins.left) finalStyles.left = styles.left;
    else if (isFixedLeft) finalStyles.left = styles.left;
    else if (centeredX && styles.left) finalStyles.left = styles.left;

    if (pins.right) finalStyles.right = styles.right;
    if (pins.top) finalStyles.top = styles.top;
    else if (isFixedTop) finalStyles.top = styles.top;
    else if (centeredY && styles.top) finalStyles.top = styles.top;

    if (pins.bottom) finalStyles.bottom = styles.bottom;
  }

  // In inset mode, don't commit width/height (CSS derives from insets)
  if (horizontalInset) delete finalStyles.width;
  if (verticalInset) delete finalStyles.height;

  // Variant root: strip left/top — position is managed by variantConfig
  if (isVariantRoot) {
    delete finalStyles.left;
    delete finalStyles.top;
  }

  return finalStyles;
}

let cleanup: (() => void) | null = null;

interface RotatedSvgResizeArgs {
  nodeId: string;
  vpId: string;
  vpPrefix: string;
  direction: Direction;
  startEvent: PointerEvent;
  contentEl: HTMLElement;
  onInteracting: (active: boolean) => void;
  onSnapGuidesChange?: (guides: SnapGuide[]) => void;
  startWidth: number;
  startHeight: number;
  startLeft: number;
  startTop: number;
  xHandle: 'left' | 'right' | null;
  yHandle: 'top' | 'bottom' | null;
  canvasScale: number;
  shapeChild: NonNullable<ReturnType<typeof findSvgShapeChild>>;
  svgRotate: { angle: number; cx: number; cy: number };
  viewBoxAttr: string;
  /** The PARENT group's CSS rotation (deg). The shape's VISUAL rotation on
   *  screen is `svgRotate.angle + groupAngleDeg` — the screen delta must be
   *  un-rotated by that TOTAL so a resize handle follows the mouse inside a
   *  rotated group. The inner-shape `transform` write still uses the inner
   *  angle only. 0 for a standalone shape / un-rotated group. */
  groupAngleDeg: number;
}

/**
 * Resize a ROTATED SVG shape "standard" so it stays rigid (no skew).
 *
 * The problem: rotation lives on the inner shape's `transform` attribute,
 * INSIDE the wrapper's viewBox→box scale. Plain resize changes width/height
 * non-uniformly → `viewBoxToBox(non-uniform) · rotate` = a skew (the user's
 * "inward perspective bending").
 *
 * the reference's fix (verified against real the reference output): keep the wrapper
 * `viewBox` 1:1 with width/height (uniform viewBoxToBox — never skews) and
 * bake the size change into the GEOMETRY. Because the geometry scale is
 * applied BEFORE the `rotate()`, the net is `rotate · localScale` — a
 * cleanly stretched + rotated shape. Each tick:
 *   1. inverse-rotate the screen delta into the shape's local frame,
 *   2. compute the new local W/H,
 *   3. scale the geometry from its original viewBox space → W×H,
 *   4. set `viewBox="0 0 W H"`, width/height, inner `transform=rotate(a W/2 H/2)`,
 *   5. shift left/top so the opposite (rotated) corner stays pinned.
 */
function startRotatedSvgShapeResize(args: RotatedSvgResizeArgs): void {
  const {
    nodeId, vpId, vpPrefix, startEvent, contentEl, onInteracting,
    onSnapGuidesChange, canvasScale, shapeChild, svgRotate, viewBoxAttr,
  } = args;
  // These mutate on zero crossing — when a dragged edge crosses the
  // opposite edge, the box "flips through itself" and from there on the
  // dragged edge IS the opposite one. We carry the new baseline (start*,
  // x/yHandle, direction) from the crossing point forward, identical to
  // the main resize path's zero-crossing handling.
  let curStartWidth = args.startWidth;
  let curStartHeight = args.startHeight;
  let curStartLeft = args.startLeft;
  let curStartTop = args.startTop;
  let curXHandle = args.xHandle;
  let curYHandle = args.yHandle;
  let curDirection = args.direction;

  // Three uses of "the angle", and they are NOT all the same when the shape
  // sits inside a rotated group:
  //   • VISUAL angle (inner + parent group's CSS rotation) — the shape's
  //     orientation ON SCREEN. The screen delta is inverse-rotated by THIS so
  //     a handle follows the mouse inside a rotated group.
  //   • INNER angle (svgRotate.angle) — the child's own rotation WITHIN the
  //     group's viewBox space. The opposite-corner PIN works in viewBox space
  //     (the group's CSS rotation is a fixed rigid transform during a child
  //     resize, so pinning in viewBox keeps the corner fixed on screen), so it
  //     uses the inner angle. The inner `transform` write also uses it.
  const innerAngleDeg = svgRotate.angle;
  const visualAngleDeg = svgRotate.angle + (args.groupAngleDeg || 0);
  const visRad = visualAngleDeg * (Math.PI / 180);
  const cosV = Math.cos(visRad), sinV = Math.sin(visRad);
  const innRad = innerAngleDeg * (Math.PI / 180);
  const cosA = Math.cos(innRad), sinA = Math.sin(innRad);
  // Shift aspect lock ratio — captured at drag start, same as the main resize
  // path's `aspectRatio`. This SVG geometry-baking path bypasses the shared
  // `applyAspectRatioLock` call in startResize, so without its own lock Shift
  // on a shape corner did nothing (frame-parity gap, user find 2026-07-24).
  const shiftRatio = args.startHeight > 0 ? args.startWidth / args.startHeight : 0;

  // viewBox dims the inner geometry lives in. Fall back to the wrapper box
  // size when the SVG has no viewBox (1:1 assumption).
  const vbParts = viewBoxAttr.split(/[\s,]+/).map(Number);
  const origVbW = (vbParts.length === 4 && vbParts[2] > 0) ? vbParts[2] : curStartWidth;
  const origVbH = (vbParts.length === 4 && vbParts[3] > 0) ? vbParts[3] : curStartHeight;
  // viewBox ORIGIN. A shape-edit reshape reframes the viewBox to the painted
  // bbox, which is often offset (e.g. "-192 35 …") when content moved into
  // negative coords. `scaleShapeGeometry` scales the geometry from (0,0), so the
  // new viewBox must carry that SAME origin (scaled) — otherwise the geometry
  // lands outside a "0 0 W H" window and the shape SHIFTS on the first resize
  // tick (the "resize jumps on mouse-down" bug). 0 for the common origin-0 case,
  // so non-offset shapes are byte-identical.
  const origVbX = (vbParts.length === 4 && Number.isFinite(vbParts[0])) ? vbParts[0] : 0;
  const origVbY = (vbParts.length === 4 && Number.isFinite(vbParts[1])) ? vbParts[1] : 0;

  // Snapshot the inner shape's ORIGINAL geometry + transform. Every tick
  // scales from THIS snapshot (never from the live, already-scaled DOM) so
  // repeated ticks don't accumulate rounding drift.
  const shapeTag = shapeChild.node.type;
  const shapeAttrs = shapeChild.node.attrs ?? {};
  const origGeomAttrs: Record<string, string | undefined> = {};
  for (const key of GEOMETRY_ATTRS_BY_TAG[shapeTag.toLowerCase()] ?? []) {
    origGeomAttrs[key] = shapeAttrs[key];
  }
  const origTransform = shapeAttrs.transform ?? '';
  const { cx: cx0, cy: cy0 } = svgRotate;

  const bridge = getCanvasBridge() as ReturnType<typeof getCanvasBridge> & {
    setChildShapeAttribute?: (parent: string, vp: string, idx: number, attr: string, value: string | null) => void;
  };
  // Also mutates on zero crossing — we reset the pointer baseline to the
  // event that caused the crossing so subsequent deltas are measured from
  // the flipped point, not from the original mousedown.
  let curStartX = startEvent.clientX;
  let curStartY = startEvent.clientY;

  // Position of a wrapper-box-local point after rotating it by `angleRad`
  // around (pivotX, pivotY) — i.e. its offset from the box origin (left,top).
  const rotatedAround = (px: number, py: number, pivotX: number, pivotY: number) => {
    const dx = px - pivotX, dy = py - pivotY;
    return {
      x: pivotX + dx * cosA - dy * sinA,
      y: pivotY + dx * sinA + dy * cosA,
    };
  };

  // Last applied values — committed to source on mouseup.
  let didApply = false;
  let lastW = curStartWidth, lastH = curStartHeight;
  let lastLeft = curStartLeft, lastTop = curStartTop;
  let lastViewBox = `0 0 ${Math.round(curStartWidth)} ${Math.round(curStartHeight)}`;
  let lastGeom: Record<string, string> = {};
  let lastTransform = origTransform;

  // Live group auto-fit target. When this rotated child sits in an SVG GROUP
  // that is a FLEX/FLOW child (position ≠ absolute → no left/top), re-fit the
  // group to its children's painted bounds EACH FRAME so the final auto-fit
  // shows LIVE (not only on mouseup). Scoped to flex groups on purpose: an
  // ABSOLUTE group's left/top compensation is NOT idempotent across the per-tick
  // re-set of un-rebased child coords (it would drift the group), so absolute
  // groups stay on the commit-time refit (which already works).
  const liveGroupId = getNodeFromCache(nodeId)?.parentId || null;
  const liveGroupNode = liveGroupId ? getNodeFromCache(liveGroupId) : null;
  const liveGroupPos = (liveGroupNode?.type === 'svg' && liveGroupId)
    ? (findNodeComputedStyles(liveGroupId, vpId, ['position']).position || '')
    : '';
  // The bridge live-refit command walks the whole `<svg>`-group ancestor chain
  // (`liveRefitGroupChainEl`) and only acts when the TOP-LEVEL group is in a
  // flex/flow LAYOUT (reflows live); on the canvas (absolute top) it's a no-op
  // → commit-time refit. So passing the immediate parent (even a NESTED group,
  // `position: static`) is safe — the chain handles nested attrs + the
  // canvas/flex decision internally.
  const liveRefitGroupId = (liveGroupNode?.type === 'svg' && liveGroupPos !== 'absolute' && liveGroupPos !== 'fixed')
    ? liveGroupId : null;

  const apply = (e: PointerEvent) => {
    didApply = true;
    // Screen delta → canvas px → inverse-rotate into the shape's local
    // (un-rotated) frame, so dragging a rotated handle resizes along the
    // shape's own axes instead of the screen axes.
    const rawDx = (e.clientX - curStartX) / canvasScale;
    const rawDy = (e.clientY - curStartY) / canvasScale;
    // Inverse-rotate by the VISUAL angle (inner + group) — the shape's on-screen
    // orientation — so the handle resizes along the axes the user sees.
    const localDx = rawDx * cosV + rawDy * sinV;
    const localDy = -rawDx * sinV + rawDy * cosV;

    const sized = calculateResizeDelta(
      curStartWidth, curStartHeight, 0, 0, localDx, localDy, curXHandle, curYHandle, false,
    );

    // Zero crossing — when the dragged edge passes the opposite edge,
    // flip the handle and direction and rebaseline from the crossing
    // point. Same model as the main resize path: `processZeroCrossing`
    // detects negative width/height, mirrors them back to positive +
    // swaps the active handle.
    let crossed = false;
    let w = sized.width;
    let h = sized.height;
    // Capture the direction BEFORE any flip this tick. On a crossing,
    // `curStart*` (the OLD box) is still the pre-flip baseline while
    // `curDirection` flips below — so the pinned "opposite corner" of the
    // OLD box must be read with this pre-flip direction. Using the flipped
    // direction picks the wrong edge of the old box, jumping the shape.
    const dirBefore = curDirection;
    if (curXHandle || curYHandle) {
      const hadX = curXHandle !== null;
      const hadY = curYHandle !== null;
      const zc = processZeroCrossing(
        sized.width, sized.height, sized.left, sized.top,
        curXHandle ?? 'right', curYHandle ?? 'bottom',
      );
      if (zc.crossed) {
        crossed = true;
        w = zc.width;
        h = zc.height;
        if (hadX) curXHandle = zc.xHandle;
        if (hadY) curYHandle = zc.yHandle;
        curDirection = updateDirectionAfterCrossing(
          curXHandle ?? zc.xHandle, curYHandle ?? zc.yHandle, curDirection,
        );
      }
    }

    const W = Math.max(MIN_SIZE, w);
    // Shift — aspect-ratio lock on a corner drag (frame parity). Width drives
    // height, mirroring the shared `applyAspectRatioLock`. The opposite-corner
    // pin below re-anchors left/top FROM the locked dims, so no extra top
    // compensation is needed here.
    const H = lockedShiftHeight(W, Math.max(MIN_SIZE, h), e.shiftKey, curXHandle, curYHandle, shiftRatio);

    // Geometry scale: original viewBox space → the new W×H box. viewBox is
    // set to "0 0 W H" so viewBoxToBox is uniform 1:1 → no skew.
    const sx = W / origVbW;
    const sy = H / origVbH;
    const scaledGeom = scaleShapeGeometry(shapeTag, origGeomAttrs, sx, sy);
    // The rotation pivot scales WITH the geometry — cx0/cy0 (painted-bbox
    // center) stays the geometry center under proportional scaling.
    const newTransform = mergeSvgRotate(origTransform, innerAngleDeg, cx0 * sx, cy0 * sy);
    const newViewBox = `${Math.round(origVbX * sx)} ${Math.round(origVbY * sy)} ${Math.round(W)} ${Math.round(H)}`;

    // Pin the opposite corner: its VISUAL position (box origin + rotated
    // offset) must stay where it started. The pivot in box coords scales
    // with the box — pivotBox = (cx0,cy0)·(boxW/origVbW, boxH/origVbH).
    // After a zero crossing, `curDirection` IS the flipped direction, so
    // the "opposite" corner is the one we're now dragging away from.
    const oppOld = getOppositeCorner(dirBefore, { left: 0, top: 0, width: curStartWidth, height: curStartHeight });
    const oppNew = getOppositeCorner(curDirection, { left: 0, top: 0, width: W, height: H });
    const visOppOld = rotatedAround(oppOld.x, oppOld.y, cx0 * curStartWidth / origVbW, cy0 * curStartHeight / origVbH);
    const visOppNew = rotatedAround(oppNew.x, oppNew.y, cx0 * W / origVbW, cy0 * H / origVbH);
    const newLeft = curStartLeft + (visOppOld.x - visOppNew.x);
    const newTop = curStartTop + (visOppOld.y - visOppNew.y);

    // Apply live (domOnly — no source write until mouseup). Order matters:
    // wrapper first, inner shape last, so the `cornersUpdate` emitted by the
    // final `setChildShapeAttribute` reflects the fully-updated geometry.
    updateNodeStyles({
      id: nodeId,
      styles: {
        width: `${Math.round(W)}px`, height: `${Math.round(H)}px`,
        left: `${Math.round(newLeft)}px`, top: `${Math.round(newTop)}px`,
      },
      contentEl,
      domOnly: true,
    });
    bridge.setAttribute(nodeId, vpPrefix, 'viewBox', newViewBox);
    for (const [k, v] of Object.entries(scaledGeom)) {
      bridge.setChildShapeAttribute?.(nodeId, vpPrefix, 0, k, v);
    }
    bridge.setChildShapeAttribute?.(nodeId, vpPrefix, 0, 'transform', newTransform || null);

    // Live group auto-fit — AFTER the child box + geometry are in the DOM, so
    // the sandbox reads the freshly-resized painted bounds. Flex group only.
    if (liveRefitGroupId) bridge.liveRefitGroup?.(liveRefitGroupId, vpPrefix);

    lastW = W; lastH = H; lastLeft = newLeft; lastTop = newTop;
    lastViewBox = newViewBox; lastGeom = scaledGeom; lastTransform = newTransform;

    // Rebaseline AFTER applying so the next tick's localDx/Dy is measured
    // from the post-crossing point. Mirrors the main resize path.
    if (crossed) {
      curStartWidth = W;
      curStartHeight = H;
      curStartLeft = newLeft;
      curStartTop = newTop;
      curStartX = e.clientX;
      curStartY = e.clientY;
      trace.action('resize:svg-rotated:crossed', {
        nodeId, vpId, xHandle: curXHandle, yHandle: curYHandle, direction: curDirection,
        W, H, newLeft, newTop,
      });
    }

    styleHelperOps.show({
      type: 'dimensions',
      position: { x: e.clientX, y: e.clientY },
      dimensions: { width: Math.round(W), height: Math.round(H), unit: 'px' },
    });
  };

  const onMove = (e: PointerEvent) => apply(e);

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    cleanup = null;
    onSnapGuidesChange?.([]);
    styleHelperOps.hide();

    // Click-without-drag: nothing changed — don't commit (would otherwise
    // rewrite the viewBox/geometry to the canonical 1:1 form needlessly).
    if (!didApply) {
      onInteracting(false);
      dragStateOps.set(false);
      return;
    }

    trace.action('resize:end:svg-rotated', {
      nodeId, vpId, width: lastW, height: lastH, left: lastLeft, top: lastTop,
    });

    // GROUP CHILD: suppress the selection overlay until the commit's FINAL
    // post-refit geometry is painted — same shapeEditCommitPendingAtom gate
    // (and forced-render clear) the drag commit uses. Without it the overlay
    // repainted at the PRE-resize rect for a beat and then jumped to the new
    // one on mouse-up (the suppression existed for drags but never for the
    // group-child resize; user report 2026-07-28). Cleared by the
    // renderComplete the forceCanvasRender below guarantees.
    const commitParentIsGroup = getNodeFromCache(getNodeFromCache(nodeId)?.parentId ?? '')?.type === 'svg';
    if (commitParentIsGroup) {
      getDefaultStore().set(shapeEditCommitPendingAtom, true);
    }

    // Commit. ORDER MATTERS for a group child: write the new viewBox + geometry
    // + transform FIRST and flush, so the group refit triggered by
    // `updateNodeStyles` (→ moveChildAndRefitGroup) computes the group bounds
    // from the RESIZED shape's painted (rotated) bbox — not the stale one. With
    // the wrong order the group box drifts off the content and a later group
    // resize "moves both edges".
    // viewBox + inner geometry are a SINGLE SHARED source attribute/child —
    // there is no per-variant / per-viewport viewBox. On a NON-PRIMARY resize
    // (a component variant or a page replica) baking the scaled viewBox+geometry
    // to source would CLOBBER every other variant (the default would render its
    // unchanged box against the resized viewBox and squish). For a non-primary
    // resize only the per-variant box (width/height, routed below via
    // updateNodeStyles → replica-context) should change; the shared geometry then
    // stretches into that box via preserveAspectRatio="none". So skip the shared
    // writes here unless this is the primary, which IS the source of truth.
    // (This path is reached for plain shapes only once shape-edit has stamped a
    // <path> child — before that there's no shapeChild and the simple resize runs.)
    const resizeIsPrimary = isPrimaryViewport(vpId);
    let bakeCompensated = false;
    if (resizeIsPrimary) {
      queueMutation({ type: 'updateHtmlAttrs', nodeId, attrs: { viewBox: lastViewBox } });
      queueMutation({
        type: 'updateSvgAttrs',
        nodeId,
        attrs: { ...lastGeom, transform: lastTransform },
        childIndex: 0,
      });
      // Seed the imperative cache with the baked wrapper viewBox + inner
      // geometry NOW — the group-child forced render below ships
      // getCachedNodesMap() (nodesAtom is stale mid-gesture) and attr
      // mutations never reach the cache on their own. Without this the
      // render repaints the PRE-resize shape (the refit seed only covers
      // x/y/width/height, not viewBox/d).
      const seededWrapper = getNodeFromCache(nodeId);
      if (seededWrapper) {
        injectNodeIntoCache({ ...seededWrapper, attrs: { ...seededWrapper.attrs, viewBox: lastViewBox } });
        const seedInnerId = seededWrapper.children?.[0];
        const seedInner = seedInnerId ? getNodeFromCache(seedInnerId) : null;
        if (seedInner) {
          injectNodeIntoCache({ ...seedInner, attrs: { ...seedInner.attrs, ...lastGeom, transform: lastTransform } });
        }
        trace.action('resize:svg-commit-cache-seeded', { nodeId, viewBox: lastViewBox, innerSeeded: !!seedInner });
      }
      // VARIANT COMPENSATION, bake edition: the bake just rewrote the SHARED
      // base box AND geometry that every variant entry derives from. The
      // redirect's generic compensation re-derives variant `d`s from the
      // CACHED base — which lags the just-queued geometry by a parse cycle
      // (live e2e 2026-06-12: variant d re-derived from the stale 147-wide
      // base while the box said 195 → ~26px painted drift). Run the
      // compensation HERE with the fresh values in hand, and flag the box
      // write below so the redirect doesn't compensate a second time.
      const bakedWrapper = getNodeFromCache(nodeId);
      if (bakedWrapper && bakedWrapper.parentId
        && getNodeFromCache(bakedWrapper.parentId)?.type === 'svg'
        && groupChildrenCarryVariantGeometry(bakedWrapper.parentId)) {
        const oldBox = {
          x: parseFloat(bakedWrapper.attrs?.x ?? '0') || 0,
          y: parseFloat(bakedWrapper.attrs?.y ?? '0') || 0,
          w: parseFloat(bakedWrapper.attrs?.width ?? '0') || 0,
          h: parseFloat(bakedWrapper.attrs?.height ?? '0') || 0,
        };
        const newBox = {
          x: Math.round(lastLeft), y: Math.round(lastTop),
          w: Math.round(lastW), h: Math.round(lastH),
        };
        const innerId = bakedWrapper.children?.[0];
        const freshDs = (innerId && lastGeom.d) ? { [innerId]: lastGeom.d } : {};
        if (innerId && lastGeom.d) {
          const innerNode = getNodeFromCache(innerId);
          if (innerNode) injectNodeIntoCache({ ...innerNode, attrs: { ...innerNode.attrs, d: lastGeom.d } });
        }
        for (const u of compensateGroupChildVariantsForBaseBox(nodeId, oldBox, newBox, freshDs)) {
          queueMutation(u as any);
        }
        bakeCompensated = true;
      }
      // Only a GROUP CHILD needs the geometry PAINTED before updateNodeStyles —
      // its parent-group refit reads the painted bbox. A STANDALONE shape has no
      // refit, so flushing here renders the new geometry against the OLD box for a
      // beat (the "mouse-up jumps back to original, then snaps to the right size"
      // flicker, ~0.2s because updateNodeStyles only QUEUES the box). Defer to the
      // single flush below so box + geometry + viewBox land in ONE render.
      const parentIsGroup = getNodeFromCache(getNodeFromCache(nodeId)?.parentId ?? '')?.type === 'svg';
      if (parentIsGroup) flushNow();
    } else {
      trace.action('resize:svg-rotated:skip-shared-viewbox', { nodeId, vpId });
    }
    // `updateNodeStyles` handles BOTH cases: top-level <svg> → CSS
    // left/top/width/height; group child → x/y/width/height SVG attrs + the
    // group bbox refit (now reading the freshly-written geometry).
    updateNodeStyles({
      id: nodeId,
      styles: {
        width: `${Math.round(lastW)}px`, height: `${Math.round(lastH)}px`,
        left: `${Math.round(lastLeft)}px`, top: `${Math.round(lastTop)}px`,
      },
      contentEl,
      skipVariantCompensation: bakeCompensated,
    });
    // ONE render: a standalone shape commits viewBox + geometry + box together,
    // so mouse-up shows the final size directly (no intermediate old-box frame).
    // Harmless no-op when updateNodeStyles already flushed (e.g. group refit).
    flushNow();

    // Group child: force a render so renderComplete fires and CLEARS the
    // shapeEditCommitPendingAtom suppression set above (the imperative commit
    // path otherwise skips renders and the overlays would stay hidden). The
    // render paints from the post-commit state, so the selection overlay
    // appears directly at the FINAL geometry — never at the pre-resize rect.
    if (commitParentIsGroup) forceCanvasRender();

    onInteracting(false);
    dragStateOps.set(false);
  };

  trace.action('resize:start:svg-rotated', {
    nodeId, vpId, direction: curDirection, innerAngleDeg, visualAngleDeg, groupAngleDeg: args.groupAngleDeg || 0, origVbW, origVbH,
    startWidth: curStartWidth, startHeight: curStartHeight,
  });
  onInteracting(true);
  dragStateOps.set(true);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    onInteracting(false);
    dragStateOps.set(false);
  };
}

/** A group's OWN rotation (deg): the SVG `transform="rotate(θ …)"` ATTRIBUTE
 *  (nested group) OR the CSS `transform: rotate(θdeg)` (top-level group). */
function svgNodeOwnRotation(node: ReturnType<typeof getNodeFromCache>): number {
  if (!node) return 0;
  const attr = parseSvgRotate(node.attrs?.transform);
  if (attr) return attr.angle;
  const m = (node.styles?.transform || '').match(/rotate\(\s*(-?[\d.]+)deg/);
  return m ? (parseFloat(m[1]) || 0) : 0;
}

/** Cumulative rotation (deg) of all `<svg>`-group ANCESTORS of `nodeId` — the
 *  rigid rotation of the coordinate frame the node's box lives in. Used as the
 *  `groupAngleDeg` so a resize handle follows the cursor at any nesting depth. */
function cumulativeSvgAncestorRotation(nodeId: string): number {
  let total = 0;
  let cur = getNodeFromCache(nodeId);
  cur = cur?.parentId ? getNodeFromCache(cur.parentId) : undefined;
  while (cur && cur.type === 'svg') {
    total += svgNodeOwnRotation(cur);
    cur = cur.parentId ? getNodeFromCache(cur.parentId) : undefined;
  }
  return total;
}

interface RotatedGroupResizeArgs {
  nodeId: string; vpId: string; vpPrefix: string; direction: Direction;
  startEvent: PointerEvent; contentEl: HTMLElement;
  onInteracting: (active: boolean) => void;
  startWidth: number; startHeight: number; startLeft: number; startTop: number;
  xHandle: 'left' | 'right' | null; yHandle: 'top' | 'bottom' | null;
  canvasScale: number;
  /** The group's OWN rotation (deg) — its `transform="rotate(θ …)"` attribute. */
  ownAngleDeg: number;
  /** Cumulative ancestor-group rotation (deg) — rigid during this resize. */
  ancestorAngleDeg: number;
}

/**
 * Resize a ROTATED nested GROUP with the SAME corner-pinning as a rotated SHAPE
 * (`startRotatedSvgShapeResize`) — zero drift, opposite corner nailed — but the
 * content is the group's CHILDREN (scaled recursively via `bakeGroupResize`)
 * instead of a single geometry. The pin math is identical: the group rotates
 * about its box CENTRE (the attribute pivot, kept fresh at the centre), so the
 * pivot fraction is (0.5, 0.5); the screen delta is inverse-rotated by the
 * VISUAL angle (own + ancestors) so the handle follows the cursor, and the
 * opposite corner is pinned in the PARENT frame (ancestor rotation is rigid).
 */
function startRotatedSvgGroupResize(args: RotatedGroupResizeArgs): void {
  const { nodeId, vpId, vpPrefix, startEvent, contentEl, onInteracting, canvasScale } = args;
  let curStartWidth = args.startWidth, curStartHeight = args.startHeight;
  let curStartLeft = args.startLeft, curStartTop = args.startTop;
  let curXHandle = args.xHandle, curYHandle = args.yHandle;
  let curDirection = args.direction;
  let curStartX = startEvent.clientX, curStartY = startEvent.clientY;

  const innerAngleDeg = args.ownAngleDeg;                       // pin works in the parent frame
  const visualAngleDeg = args.ownAngleDeg + args.ancestorAngleDeg; // delta inverse-rotation
  const innRad = innerAngleDeg * (Math.PI / 180);
  const cosA = Math.cos(innRad), sinA = Math.sin(innRad);
  const visRad = visualAngleDeg * (Math.PI / 180);
  const cosV = Math.cos(visRad), sinV = Math.sin(visRad);
  // origVbW/H = original box (== viewBox, 1:1) — children scale from this snapshot.
  const origVbW = curStartWidth, origVbH = curStartHeight;
  // Shift aspect lock — same frame-parity gap as the rotated-shape path (this
  // loop also bypasses startResize's shared `applyAspectRatioLock`).
  const shiftRatio = args.startHeight > 0 ? args.startWidth / args.startHeight : 0;

  const bridge = getCanvasBridge();
  // Box-local point rotated by the inner angle about the box CENTRE (the pivot).
  const rotatedAround = (px: number, py: number, pivotX: number, pivotY: number) => {
    const dx = px - pivotX, dy = py - pivotY;
    return { x: pivotX + dx * cosA - dy * sinA, y: pivotY + dx * sinA + dy * cosA };
  };

  let didApply = false;
  let lastW = curStartWidth, lastH = curStartHeight, lastLeft = curStartLeft, lastTop = curStartTop;

  const apply = (e: PointerEvent) => {
    didApply = true;
    const rawDx = (e.clientX - curStartX) / canvasScale;
    const rawDy = (e.clientY - curStartY) / canvasScale;
    // Inverse-rotate by the VISUAL angle so the handle resizes along screen axes.
    const localDx = rawDx * cosV + rawDy * sinV;
    const localDy = -rawDx * sinV + rawDy * cosV;
    const sized = calculateResizeDelta(curStartWidth, curStartHeight, 0, 0, localDx, localDy, curXHandle, curYHandle, false);

    let crossed = false;
    let w = sized.width, h = sized.height;
    const dirBefore = curDirection;
    if (curXHandle || curYHandle) {
      const hadX = curXHandle !== null, hadY = curYHandle !== null;
      const zc = processZeroCrossing(sized.width, sized.height, sized.left, sized.top, curXHandle ?? 'right', curYHandle ?? 'bottom');
      if (zc.crossed) {
        crossed = true; w = zc.width; h = zc.height;
        if (hadX) curXHandle = zc.xHandle;
        if (hadY) curYHandle = zc.yHandle;
        curDirection = updateDirectionAfterCrossing(curXHandle ?? zc.xHandle, curYHandle ?? zc.yHandle, curDirection);
      }
    }
    const W = Math.max(MIN_SIZE, w);
    // Shift — corner aspect lock, width drives height (frame parity). The
    // centre-pivot pin below re-anchors from the locked dims.
    const H = lockedShiftHeight(W, Math.max(MIN_SIZE, h), e.shiftKey, curXHandle, curYHandle, shiftRatio);

    // Pin the opposite corner about the box CENTRE (the group rotates about its
    // centre). Identical math to the rotated-shape pin, pivot fraction = 0.5.
    const oppOld = getOppositeCorner(dirBefore, { left: 0, top: 0, width: curStartWidth, height: curStartHeight });
    const oppNew = getOppositeCorner(curDirection, { left: 0, top: 0, width: W, height: H });
    const visOppOld = rotatedAround(oppOld.x, oppOld.y, curStartWidth / 2, curStartHeight / 2);
    const visOppNew = rotatedAround(oppNew.x, oppNew.y, W / 2, H / 2);
    const newLeft = curStartLeft + (visOppOld.x - visOppNew.x);
    const newTop = curStartTop + (visOppOld.y - visOppNew.y);

    // Set the pinned x/y FIRST (so the bake reads them when re-centring the
    // pivot), then bake the children + box + viewBox at the new scale.
    bridge.patchAttrsAndStyles?.(nodeId, vpPrefix, { x: `${Math.round(newLeft)}`, y: `${Math.round(newTop)}` }, {});
    bridge.bakeGroupResize?.(nodeId, vpPrefix, W / origVbW, H / origVbH);

    lastW = W; lastH = H; lastLeft = newLeft; lastTop = newTop;
    if (crossed) {
      curStartWidth = W; curStartHeight = H; curStartLeft = newLeft; curStartTop = newTop;
      curStartX = e.clientX; curStartY = e.clientY;
    }
    styleHelperOps.show({ type: 'dimensions', position: { x: e.clientX, y: e.clientY }, dimensions: { width: Math.round(W), height: Math.round(H), unit: 'px' } });
  };

  const onMove = (e: PointerEvent) => apply(e);
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    cleanup = null;
    styleHelperOps.hide();
    if (didApply) {
      // Commit: scale children (recursively) + viewBox + box (width/height + the
      // pinned x/y) + re-centre the rotate pivot — all in normalizeGroupOnResize.
      const filePath = getActiveFilePath();
      normalizeGroupOnResize(filePath, nodeId, Math.round(lastW), Math.round(lastH), Math.round(lastLeft), Math.round(lastTop));
      flushNow();
      const chain = getSvgGroupAncestorChain(nodeId).filter(gid => gid !== nodeId);
      if (chain.length > 0) refitGroupChain(chain, filePath);
      bridge.clearGroupResizeBake?.(nodeId);
    }
    onInteracting(false);
    dragStateOps.set(false);
  };
  onInteracting(true);
  dragStateOps.set(true);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    onInteracting(false);
    dragStateOps.set(false);
  };
}

export function startResize(
  nodeId: string,
  vpId: string,
  direction: Direction,
  startEvent: PointerEvent,
  callbacks: ResizeCallbacks,
): void {
  if (cleanup) { cleanup(); cleanup = null; }

  const { contentEl, onInteracting } = callbacks;
  const vpPrefix = getViewportPrefix(vpId);

  // Read node data directly from internal cache (bypasses atom staleness after resize/drag)
  const nodeData = getNodeFromCache(nodeId);

  // Fixed overlays (modals) are NOT resizable — they always cover the full
  // viewport (the Renderer sizes them to the tile, not the user). Bail before any
  // resize state is installed (`cleanup` was already cleared above). Relative
  // overlays still resize (their box is meaningful); only fixed is blocked.
  {
    const ovAttr = nodeData?.attrs?.['data-overlay'];
    if (ovAttr) {
      try {
        if (JSON.parse(ovAttr).type === 'fixed') {
          trace.fn('resize:blocked-fixed-overlay', { nodeId });
          return;
        }
      } catch { /* skip */ }
    }
  }

  // Read element's inline styles from NodeMap (not DOM)
  const nodeStyles = nodeData?.styles || {};
  // A VECTOR SET instance (imported icon/vector component) is ALWAYS aspect-ratio
  // locked — like the reference, you can't distort it; any handle scales proportionally.
  const isVectorSet = isVectorSetComponentFile(nodeData?.componentFile);

  // Read geometry from bridge computed cache — populated on every render with actual
  // getComputedStyle values. Works correctly for rotated elements (unlike BCR-derived values).
  // This is the iframe equivalent of the old `getComputedStyle(el).width` path.
  const computedStyles = findNodeComputedStyles(nodeId, vpId, ['width', 'height', 'transform', 'display', 'left', 'top', 'right', 'bottom']);
  const nodeRect = findNodeRect(nodeId, vpId);
  const canvasScale = transformManager.getTransform().scale;
  // A NESTED svg group keeps its box in `width/height` ATTRIBUTES. For a ROTATED
  // one, `getComputedStyle().width` / the bounding rect report the ROTATED AABB
  // (e.g. 881 for a 604-wide box), so the resize delta math would operate on the
  // wrong size and jump. Read the authoritative box size from the attrs (same as
  // startLeft/startTop reading x/y).
  const parentForDims = nodeData?.parentId ? getNodeFromCache(nodeData.parentId) : null;
  const isNestedSvgForDims = nodeData?.type === 'svg' && parentForDims?.type === 'svg';
  const attrW = parseFloat(nodeData?.attrs?.width ?? '');
  const attrH = parseFloat(nodeData?.attrs?.height ?? '');
  // VARIANT painting of a group child: the baseline is the PAINTED box, not
  // the shared base attrs — the variant entry's scale/deltas paint it at
  //   left = x0 + dx + w·(1 − sx)/2,  width = w·sx  (fill-box-center math,
  // mirror of replica-context groupChildBoxToMotion / DragCoordinator's
  // svgGroupChildStartPosition). Baselining from the bare attrs ran the whole
  // gesture in the base frame: resize:start showed startWidth 68 on a painted
  // 100-wide child, and the commit relocated the box to the base-frame
  // position — the user-visible "offsets on mouse-up" (live find 2026-06-12).
  // Primary reads the DEFAULT entry — the unified rotation channel stores a
  // primary rotation there (motion rotate + carrier); its size/position
  // values are neutral by the transform law, so every baseline below
  // evaluates identically to the bare attrs when unrotated.
  const variantEntryForStart = (isNestedSvgForDims && isComponentFilePath(getActiveFilePath()))
    ? (() => {
      const own = nodeData?.motionVariants?.[isPrimaryViewport(vpId) ? 'default' : vpId];
      const def = isPrimaryViewport(vpId) ? undefined : nodeData?.motionVariants?.default;
      // Inheritance: an untouched variant's baseline = the default entry.
      return (own || def) ? ({ ...(def ?? {}), ...(own ?? {}) } as Record<string, string | number>) : null;
    })()
    : null;
  const entryNum = (v: string | number | undefined, dflt: number): number => {
    if (v == null || v === '') return dflt;
    const n = parseFloat(String(v));
    return Number.isFinite(n) ? n : dflt;
  };
  const startSx = entryNum(variantEntryForStart?.scaleX, 1);
  const startSy = entryNum(variantEntryForStart?.scaleY, 1);
  const startDx = entryNum(variantEntryForStart?.x, 0);
  const startDy = entryNum(variantEntryForStart?.y, 0);
  // GEOMETRY channel (rotated children): the painted size lives as px
  // METADATA in the entry (the size is baked into per-variant inner `d`s,
  // not a CSS scale) — metadata wins over the scale product.
  const startMetaW = entryNum(variantEntryForStart?.width, 0);
  const startMetaH = entryNum(variantEntryForStart?.height, 0);
  const paintedStartW = startMetaW > 0 ? startMetaW : (Number.isFinite(attrW) ? attrW : 0) * startSx;
  const paintedStartH = startMetaH > 0 ? startMetaH : (Number.isFinite(attrH) ? attrH : 0) * startSy;
  const startWidth = (isNestedSvgForDims && Number.isFinite(attrW) && attrW > 0)
    ? (variantEntryForStart ? paintedStartW : attrW)
    : (parseFloat(computedStyles.width) || parseFloat(nodeStyles.width || '') || (nodeRect ? nodeRect.width / canvasScale : 0));
  const startHeight = (isNestedSvgForDims && Number.isFinite(attrH) && attrH > 0)
    ? (variantEntryForStart ? paintedStartH : attrH)
    : (parseFloat(computedStyles.height) || parseFloat(nodeStyles.height || '') || (nodeRect ? nodeRect.height / canvasScale : 0));
  const startX = startEvent.clientX;
  const startY = startEvent.clientY;

  // Parent dimensions — try computed cache for parent, fall back to rect
  const parentId = nodeData?.parentId || null;
  let parentCssWidth = 0;
  let parentCssHeight = 0;
  if (parentId) {
    const parentComputed = findNodeComputedStyles(parentId, vpId, ['width', 'height']);
    parentCssWidth = parseFloat(parentComputed.width) || 0;
    parentCssHeight = parseFloat(parentComputed.height) || 0;
  }
  if (parentCssWidth === 0 && parentCssHeight === 0 && parentId) {
    const parentRect = findNodeRect(parentId, vpId);
    if (parentRect) {
      parentCssWidth = parentRect.width / canvasScale;
      parentCssHeight = parentRect.height / canvasScale;
    }
  }
  const elTransform = computedStyles.transform || nodeStyles.transform || '';
  // SVG-group child fast-path: nested `<svg>` inside another `<svg>`
  // positions via `x/y` ATTRS (not CSS), so `computedStyles.left/top`
  // come back as `'auto'` and resolvePos on empty inline styles returns
  // 0. Resize then computes deltas relative to a phantom (0, 0) origin
  // — including zero-crossing flips, which read the wrong "left" base
  // and snap the wrapper back instead of mirroring it. Read the real
  // start position from the parsed `node.attrs.x/y` (where groupSvgs /
  // resize commit / drag commit all write) so the resize math operates
  // on the actual coords. Same pattern as DragCoordinator's start-
  // position read for SVG-group children.
  const parentForSize = nodeData?.parentId ? getNodeFromCache(nodeData.parentId) : null;
  const isSvgGroupChild = nodeData?.type === 'svg' && parentForSize?.type === 'svg';
  // Variant painting: painted left = attrX + dx + attrW·(1 − sx)/2 (see the
  // startWidth comment above); primary keeps the bare attrs.
  const startLeft = isSvgGroupChild
    ? ((parseFloat(nodeData?.attrs?.x ?? '0') || 0)
      + (variantEntryForStart ? startDx + ((Number.isFinite(attrW) ? attrW : 0) - paintedStartW) / 2 : 0))
    : (parseFloat(computedStyles.left) || resolvePos(nodeStyles.left, nodeStyles.right, startWidth, parentCssWidth, elTransform, 'x', 0));
  const startTop = isSvgGroupChild
    ? ((parseFloat(nodeData?.attrs?.y ?? '0') || 0)
      + (variantEntryForStart ? startDy + ((Number.isFinite(attrH) ? attrH : 0) - paintedStartH) / 2 : 0))
    : (parseFloat(computedStyles.top) || resolvePos(nodeStyles.top, nodeStyles.bottom, startHeight, parentCssHeight, elTransform, 'y', 0));

  // Mutable state — reset after zero crossing
  let curWidth = startWidth;
  let curHeight = startHeight;
  let curLeft = startLeft;
  let curTop = startTop;
  let curStartX = startX;
  let curStartY = startY;
  let { xHandle, yHandle } = getHandlesFromDirection(direction);
  const isCorner = xHandle !== null && yHandle !== null;
  const aspectRatio = startHeight > 0 ? startWidth / startHeight : 1;
  // Which axes the handle affects (stable — doesn't change during zero crossing)
  const handleAffectsX = xHandle !== null;
  const handleAffectsY = yHandle !== null;

  // Detect original width/height units for unit-preserving resize. '%' keeps its
  // parent-relative path; viewport/font units (vh/vw/rem/em/cqh/…) are preserved
  // by reusing the element's OWN start px↔unit ratio so the commit stays in-unit
  // and stable (was reverting to px on mouse-up). Everything else commits in px.
  // startWidth/startHeight are the element's start size in px; origW/HValue is the
  // numeric part of the source style (e.g. 100 for '100vh') → px-per-1-unit ratio.
  // The unit must come from the TILE-EFFECTIVE value, not the base style: a
  // replica's `%` height lives in the variant branch (conditionalStyles /
  // dim-prop), while nodeStyles.height still says the primary's px — the
  // resize then committed px onto a % branch (unit flip on mouse-up,
  // trace find 2026-08-15). bakeStylesForTile is the paint-shared resolver,
  // so the unit we preserve is exactly the unit the tile renders.
  let effWidthSrc = nodeStyles.width;
  let effHeightSrc = nodeStyles.height;
  if (nodeData) {
    try {
      const effTile = bakeStylesForTile(nodeData, tileContextFor(vpId, getActiveFilePath(), getViewportWidths()));
      effWidthSrc = effTile.width ?? effWidthSrc;
      effHeightSrc = effTile.height ?? effHeightSrc;
    } catch { /* tile context unavailable — base units */ }
  }
  const origWidthUnit = parseDimUnit(effWidthSrc);
  const origHeightUnit = parseDimUnit(effHeightSrc);
  const origWidthValue = parseFloat(effWidthSrc ?? '') || 0;
  const origHeightValue = parseFloat(effHeightSrc ?? '') || 0;
  const widthPxPerUnit = origWidthValue > 0 ? startWidth / origWidthValue : 0;
  const heightPxPerUnit = origHeightValue > 0 ? startHeight / origHeightValue : 0;

  // Detect if element is inside a layout parent (flex/grid) — no left/top changes
  // Detect if element is inside a layout parent (flex/grid) — no left/top changes.
  // Canvas nodes (isCanvasNode) are always absolute, never in layout — skip parent check.
  let parentDisplay = '';
  const isCanvasNode = nodeData?.isCanvasNode === true;
  if (parentId && !isCanvasNode && !parentId.startsWith('layout::')) {
    parentDisplay = findNodeComputedStyles(parentId, vpId, ['display']).display || '';
  }
  // CRITICAL: an `position: absolute` child sits OUTSIDE its flex/grid
  // parent's flow — its `left`/`top` are real positioned coords, NOT
  // controlled by the parent's layout algorithm. Treating it as
  // "in layout" disables transform compensation AND skips the
  // left/top updates that keep the opposite corner anchored, so
  // resizing such a child drifts visually instead of pinning the
  // opposite edge. Excluding absolute (and fixed) children from
  // `isInLayout` makes the universal anchor logic kick in for them
  // alongside truly-free-positioned canvas nodes.
  const childPosition = nodeStyles.position || computedStyles.position || '';
  const isFreePositioned = childPosition === 'absolute' || childPosition === 'fixed';
  const isInLayout = !isCanvasNode
    && !isFreePositioned
    && (parentDisplay === 'flex' || parentDisplay === 'inline-flex' || parentDisplay === 'grid' || parentDisplay === 'inline-grid');

  // ─── SVG shape → dedicated geometry-baking resize path ───────────────
  // ANY single-shape SVG resize routes here, rotated or not. The
  // function keeps `viewBox` 1:1 with width/height and bakes the size
  // change into the GEOMETRY (path d, polygon points, primitive attrs)
  // — so the wrapper is never left in a non-uniform-viewBox state.
  //
  // Why even the un-rotated case goes here: if the user resizes first
  // (standard path = just changes width/height; viewBox stays at the
  // original geometry size) and rotates AFTER, the rotation then
  // operates inside a `viewBoxToBox(non-uniform)` map, producing the
  // skewed "perspective bending" the user reported. Routing un-rotated
  // resizes through here too means the wrapper always exits resize
  // with a `viewBox="0 0 W H"` matching width/height, so any later
  // rotation operates on a uniform base and looks rigid.
  const svgShapeChild = nodeData?.type === 'svg'
    ? findSvgShapeChild(nodeData, getDefaultStore().get(nodesAtom))
    : null;
  const svgRotate = svgShapeChild ? parseSvgRotate(svgShapeChild.node.attrs?.transform) : null;
  // A TOP-LEVEL svg shape rotated via its WRAPPER's CSS transform (the per-variant
  // rotation path) must NOT use this geometry-baking resize: it would bake in the
  // un-rotated frame while the box is visually rotated → the "perspective bending"
  // jump on mouseup. The standard resize below already de-skews a CSS-rotated box
  // (snapResizeRotated + opposite-corner pin via the element matrix), so let it
  // fall through. The baking path stays for UN-rotated shapes (keeps viewBox 1:1
  // for a clean later rotation) and for nested shapes (inner-attr rotation, where
  // the rotation is genuinely inside the SVG coordinate space).
  const wrapperCssRotated = Math.abs(parseRotationFromMatrix(elTransform)) > 0.01;
  // NON-PRIMARY (component variant / page replica): the viewBox + geometry are a
  // SHARED source attribute/child — only this tile's per-variant BOX should
  // change; the shared geometry stretches into it via preserveAspectRatio="none".
  // The baking path BAKES the scaled geometry+viewBox live (per tile) but the
  // commit correctly skips the shared writes → the live preview and the committed
  // result disagree → the shape jumps/offsets on mouse-up in a variant replica.
  // The standard resize below changes only the box (per-variant via
  // updateNodeStyles → replica-context), with no geometry baking, so live ==
  // commit. Keep the baking path for the PRIMARY, where the geometry IS the
  // source of truth and baking viewBox 1:1 is correct.
  // (When the group carries per-variant geometry, the bake commit syncs the
  // inner child's cached `d` before the box write so the redirect's variant
  // compensation re-derives per-variant geometry from the NEW base — gating
  // the bake off instead sent rotated primary children down the axis path,
  // which both skews their painted geometry under the box stretch AND maps
  // edge handles in the unrotated frame — the "drag left edge, right edge
  // moves" inversion; live find 2026-06-12.)
  if (svgShapeChild && !isInLayout && !wrapperCssRotated && isPrimaryViewport(vpId)) {
    // No `rotate()` attr yet → synthesize a zero-angle rotation pivoted
    // at the viewBox center. The function only uses `angle`/`cx`/`cy`
    // for the inner-shape transform (which `mergeSvgRotate` collapses
    // to empty for angle=0) and for the pin-compensation math (which
    // is a no-op at angle=0). Effect: viewBox normalization + geometry
    // scaling, no rotation written.
    const vbAttr = nodeData?.attrs?.viewBox ?? '';
    const vbParts = vbAttr.split(/[\s,]+/).map(Number);
    const vbW = (vbParts.length === 4 && vbParts[2] > 0) ? vbParts[2] : startWidth;
    const vbH = (vbParts.length === 4 && vbParts[3] > 0) ? vbParts[3] : startHeight;
    const effectiveRotate = svgRotate ?? { angle: 0, cx: vbW / 2, cy: vbH / 2 };
    // Parent GROUP's CSS rotation — the shape is visually rotated by it too, so
    // the resize delta must be un-rotated by inner+group (else dragging an edge
    // inside a rotated group goes the wrong way).
    let groupAngleDeg = 0;
    if (parentForSize?.type === 'svg') {
      // The shape's whole ancestor-group chain rotates it visually — sum ALL of
      // them (own CSS rotate of a top-level group OR `transform` attr of nested
      // groups), not just the immediate parent's CSS rotate.
      groupAngleDeg = cumulativeSvgAncestorRotation(nodeId);
    }
    startRotatedSvgShapeResize({
      nodeId, vpId, vpPrefix, direction, startEvent, contentEl,
      onInteracting,
      onSnapGuidesChange: callbacks.onSnapGuidesChange,
      startWidth, startHeight, startLeft, startTop,
      xHandle, yHandle, canvasScale,
      shapeChild: svgShapeChild,
      svgRotate: effectiveRotate,
      viewBoxAttr: vbAttr,
      groupAngleDeg,
    });
    return;
  }

  // ROTATED GROUP — an `<svg>` with `<svg>` children that is visually rotated
  // by its OWN `transform="rotate(θ …)"` attribute OR an ancestor group. Resize
  // it with the SAME corner-pinning as a rotated shape (zero drift), scaling its
  // children RECURSIVELY (via the bake) instead of a single geometry. Non-rotated
  // nested groups fall through to the normal baked-group path below.
  {
    const isGroupNode = nodeData?.type === 'svg'
      && (nodeData.children ?? []).some(cid => getNodeFromCache(cid)?.type === 'svg');
    const ownAngleDeg = svgNodeOwnRotation(nodeData);
    const ancestorAngleDeg = cumulativeSvgAncestorRotation(nodeId);
    if (isGroupNode && !isInLayout && (Math.abs(ownAngleDeg) > 0.001 || Math.abs(ancestorAngleDeg) > 0.001)) {
      startRotatedSvgGroupResize({
        nodeId, vpId, vpPrefix, direction, startEvent, contentEl, onInteracting,
        startWidth, startHeight, startLeft, startTop,
        xHandle, yHandle, canvasScale, ownAngleDeg, ancestorAngleDeg,
      });
      return;
    }
  }

  // Overlay detection — relative overlays live-position from their trigger via
  // computeOverlayPosition (the SAME math the portal renderer applies on
  // commit, so mid-drag can't drift from the final state). Fixed overlays are
  // NOT treated as overlay nodes for resize (they resize like normal elements).
  // Detect via the PARSED `data-overlay` attr: `data-overlay-node` is a
  // DOM-only marker the Renderer stamps at build time — it never exists in
  // node.attrs, so keying off it left this whole branch dead and overlay
  // resizes ran the generic path until mouse-up snapped them.
  const nodeAttrs = nodeData?.attrs || {};
  let isOverlayNode = false;
  let isCanvasOverlayNode = false;
  let overlayCfg: OverlayConfig | null = null;
  // Both viewport AND canvas overlays take the overlay path (alignment-aware live
  // resize — center grows symmetrically, end pins the far edge, commit writes
  // ONLY width/height). They differ ONLY in HOW the box is repositioned each
  // frame: a viewport overlay against its trigger in EACH viewport portal; a
  // canvas overlay against its trigger in CONTENT-CONTAINER space. The positioning
  // block below branches on `isCanvasOverlayNode`. (Treating a canvas overlay as a
  // plain node made it resize top-left-anchored and only recenter on mouse-up.)
  if (nodeAttrs['data-overlay']) {
    try {
      const cfg = JSON.parse(nodeAttrs['data-overlay']);
      if (cfg.type !== 'fixed') {
        isOverlayNode = true;
        overlayCfg = cfg;
        isCanvasOverlayNode = !!nodeData?.isCanvasNode;
      }
    } catch { /* skip */ }
  }
  trace.fn('resize:overlay-detect', { nodeId, isOverlayNode, hasOverlayAttr: !!nodeAttrs['data-overlay'] });

  // Detect inset mode from element's EFFECTIVE styles in the current
  // viewport — base inline + any @media replica override merged on top.
  // Reading only `nodeStyles` (base) misses inset pins that were
  // authored exclusively on a replica (e.g. user pinned all four
  // sides on tablet only). Without the merge, resize on the replica
  // sees `width: 338px, height: 163px, left: 13.8%, top: 26.2%` and
  // treats it as a fixed-size element → writes width/height on resize,
  // wiping the replica's `right`/`bottom` insets. With the merge,
  // resize sees `left+right+top+bottom` and writes the new
  // right/bottom values back to the replica instead. Same path the
  // PositionTool's PinControl uses to display the right pin state
  // for the current viewport.
  const replicaOverrides = getDefaultStore().get(containerOverridesAtom).get(nodeId);
  const allVpsForOverride = getDefaultStore().get(viewportsConfigAtom);
  const currentVpConfig = allVpsForOverride.find(v => v.id === vpId);
  const currentVpMaxWidth = currentVpConfig?.width ?? 0;
  const replicaProps = replicaOverrides?.get(currentVpMaxWidth) ?? new Map<string, string>();
  const mergedStyles: Record<string, string> = { ...nodeStyles };
  for (const [prop, val] of replicaProps) {
    if (val === '' || val === 'auto') {
      delete mergedStyles[prop];
    } else {
      mergedStyles[prop] = val;
    }
  }
  const insetStyles: Record<string, string> = {};
  if (mergedStyles.left) insetStyles.left = mergedStyles.left;
  if (mergedStyles.right) insetStyles.right = mergedStyles.right;
  if (mergedStyles.top) insetStyles.top = mergedStyles.top;
  if (mergedStyles.bottom) insetStyles.bottom = mergedStyles.bottom;
  if (mergedStyles.width) insetStyles.width = mergedStyles.width;
  if (mergedStyles.height) insetStyles.height = mergedStyles.height;
  const inset = getInsetState(insetStyles);
  const parentWidth = parentCssWidth;
  const parentHeight = parentCssHeight;

  // Track which properties are fixed px (safe to update during resize)
  // vs percentage (must NOT be touched — they're relative positioning)
  // SVG-group children carry no inline CSS `left/top` — their position
  // lives in the SVG `x/y` attrs — so treat them as fixed-px positioning
  // unconditionally so the resize loop's `else if (isFixedLeft)` branch
  // actually fires and writes the new left/top, which patchNodeStyles
  // redirects to bridge-patched x/y attrs. Without this, zero-crossing
  // computes the correct flipped left but never writes it → wrapper
  // visually snaps back at width = 0 instead of mirroring across the
  // cursor.
  const isFixedLeft = isSvgGroupChild ? true : !!insetStyles.left?.includes('px');
  const isFixedTop = isSvgGroupChild ? true : !!insetStyles.top?.includes('px');

  // CENTER-POSITIONED axis: `left: N%` + `translateX(-50%)` (the un-pinned-axis
  // form PositionTool writes — the % aims the element's CENTER). It's neither
  // pinned nor fixed-px, so the branches below never wrote `left` — an edge
  // drag then changed only `width` while the center % stayed put, growing the
  // box symmetrically around it instead of holding the opposite edge (user
  // report 2026-07-29, "only top pinned" resize). For these axes the live loop
  // + commit must re-aim the center from the drag math's visual rect
  // (`newLeft + newWidth/2`), keeping the translate untouched. Same transform
  // detection as `resolvePos`'s start compensation.
  const authoredTransformForCenter = String(nodeStyles.transform ?? '');
  const isCenteredX = !isSvgGroupChild && !isFixedLeft
    && !inset.pins.left && !inset.pins.right
    && !!insetStyles.left?.includes('%')
    && (authoredTransformForCenter.includes('translateX(-50%)') || authoredTransformForCenter.includes('translate(-50%'));
  const isCenteredY = !isSvgGroupChild && !isFixedTop
    && !inset.pins.top && !inset.pins.bottom
    && !!insetStyles.top?.includes('%')
    && (authoredTransformForCenter.includes('translateY(-50%)') || authoredTransformForCenter.includes('translate(-50%, -50%)') || authoredTransformForCenter.includes('translate(-50%,-50%)'));
  // PLAIN-% axis: `left: N%` with NO centering translate — the % anchors the
  // left EDGE (the form a drag-commit leaves behind on a top-only-pinned
  // node). Also never px/pinned, so `left` was never written: a LEFT-edge
  // drag left the left edge nailed to the stale % and the growth spilled out
  // the RIGHT side (user report 2026-07-29 round 2). Unlike the centered
  // form there's no self-referential translate — `newLeft` maps 1:1 to the
  // css value, so live+commit just re-express it as %. Symmetric (Alt)
  // resize keeps these writes: newLeft is already center-adjusted there.
  const isPercentX = !isSvgGroupChild && !isFixedLeft && !isCenteredX
    && !inset.pins.left && !inset.pins.right
    && !!insetStyles.left?.includes('%');
  const isPercentY = !isSvgGroupChild && !isFixedTop && !isCenteredY
    && !inset.pins.top && !inset.pins.bottom
    && !!insetStyles.top?.includes('%');
  // (No pivot-side capture needed: the centered-axis write derives from the
  // transform-compensated newLeft/newTop + a translate-size correction, which
  // is continuous through zero-crossing by construction.)

  // Get matrix for transform compensation (only for absolute-positioned elements).
  // Try: 1) computed cache (matrix form), 2) nodeStyles.transform (CSS form → convert via DOMMatrix)
  let matrixStr = computedStyles.transform || '';
  if ((!matrixStr || matrixStr === 'none') && nodeStyles.transform) {
    try {
      const m = new DOMMatrix(nodeStyles.transform);
      matrixStr = m.toString();
    } catch { /* skip invalid */ }
  }
  // A NESTED svg (parent is `<svg>`) rotates via the SVG `transform` ATTRIBUTE,
  // whose `getComputedStyle().transform` matrix is in SVG USER space, NOT screen
  // px. The rotated-resize math (fixedPoint / getTransformedPoint) assumes a
  // SCREEN-space matrix, so feeding it the user-space matrix produces a runaway
  // scale (children explode to tens of thousands of px and corrupt the source).
  // Until rotated-nested-group resize is done in user space, resize a rotated
  // nested group in its LOCAL (unrotated) frame — stable, no explosion. The
  // rotation attribute is preserved; only the box (width/height/x/y attrs)
  // changes. (Top-level groups keep the screen-matrix rotated path.)
  const parentNodeForTx = nodeData?.parentId ? getNodeFromCache(nodeData.parentId) : null;
  const isNestedSvg = nodeData?.type === 'svg' && parentNodeForTx?.type === 'svg';
  // VARIANT-ROTATED child: its rotation is a CSS fold (entry `rotate` + the
  // view-box px carrier) — a clean rotation matrix in GROUP units, matching
  // the group-map delta basis. The user-space-explosion hazard above is the
  // ATTR-rotation matrix, which variant children don't use. Synthesize the
  // matrix from the entry so the rotated fixed-corner machinery runs: the
  // dragged edge follows the cursor and the painted OPPOSITE corner stays
  // pinned via left/top compensation (live find 2026-06-12: dragging the
  // bottom handle of a rotated variant child moved the opposite corner).
  const entryRotateDeg = entryNum(variantEntryForStart?.rotate, 0);
  // CANVAS-NODE channel: module-scope group children can't use variants
  // (initialVariant is function-scoped), so their rotation is the plain CSS
  // `rotate` style + the same view-box px carrier. Identical geometry — a
  // clean rotation in GROUP units about the box centre. Without folding it
  // in here, hasTransform stayed false and the resize ran UNROTATED local
  // math: at 141.6° the screen-right edge is the local LEFT edge, so
  // dragging right SHRANK width to 0 and flipped (the user's "completely
  // shrinks in all the wrong directions", live repro 2026-06-12).
  const styleRotateDeg = parseFloat(String(nodeData?.styles?.rotate ?? '').replace('deg', '')) || 0;
  const variantRotateDeg = (variantEntryForStart && Math.abs(entryRotateDeg) > 0.001)
    ? entryRotateDeg
    : styleRotateDeg;
  const isVariantRotatedChild = isNestedSvg && Math.abs(variantRotateDeg) > 0.001;
  if (isVariantRotatedChild) {
    try { matrixStr = new DOMMatrix(`rotate(${variantRotateDeg}deg)`).toString(); } catch { /* keep */ }
  }
  const hasTransform = !isInLayout && !!matrixStr && matrixStr !== 'none'
    && (!isNestedSvg || isVariantRotatedChild);
  trace.action('resize:transform-check', {
    computedTransform: computedStyles.transform || '(empty)',
    nodeStylesTransform: nodeStyles.transform || '(empty)',
    matrixStr: matrixStr || '(empty)',
    hasTransform,
    nodeDataExists: !!nodeData,
    nodeStyleKeys: Object.keys(nodeStyles),
  });

  // Track current inline styles for live reads during onMove (updated by patchNodeStyles)
  const liveStyles: Record<string, string> = { ...nodeStyles };
  // Set when the centered/plain-% live branches actually wrote left/top this
  // gesture — the commit must include exactly those (liveStyles is seeded
  // from BASE styles, so non-emptiness can't distinguish; and pushing an
  // unwritten base value would clobber replica-specific positions).
  let wrotePctLeft = false;
  let wrotePctTop = false;

  // ─── Rotation pivot as a FRACTION of the box ────────────────────────────
  // The compensation that pins the opposite corner must rotate points around
  // the SAME pivot the browser does — the element's `transform-origin`, NOT
  // always the box centre. An SVG GROUP rotates around its painted-content
  // centre (a px transform-origin that isn't width/2,height/2), so assuming
  // the centre made rotated-group resizes "swing". Express the pivot as a
  // fraction of the box (kx = originX/width): centre-origin elements give
  // kx=ky=0.5 (identical to the old behaviour), and the fraction TRACKS the
  // box correctly as width/height change during the drag — matching how
  // `normalizeGroupOnResize` scales the origin on commit (no mouseup jump).
  // Only an EXPLICIT px transform-origin (the SVG-group case) needs special
  // handling. A `50% 50%` / `center` / unset origin auto-tracks the box
  // centre in CSS, and kx=ky=0.5 reproduces the old behaviour exactly. A
  // fixed px origin does NOT auto-track, so we must also patch it each tick
  // (below) to keep the CSS pivot == the math pivot as the box resizes.
  const inlineOrigin = (nodeStyles.transformOrigin || '').trim();
  let pivotKx = 0.5, pivotKy = 0.5, originNeedsTracking = false;
  if (isVariantRotatedChild) {
    // The view-box carrier origin is px in GROUP units (vbOx + x + w/2) — NOT
    // box-local px. Treating it as box-local put the pivot fraction > 1 and
    // the fixed-corner compensation snapped ~18px on mouse-up (live e2e
    // 2026-06-12). By construction the carrier IS the box centre: 0.5/0.5.
  } else {
    const m = inlineOrigin.match(/^(-?[\d.]+)px\s+(-?[\d.]+)px/);
    if (m && startWidth > 0 && startHeight > 0) {
      const kx = parseFloat(m[1]) / startWidth;
      const ky = parseFloat(m[2]) / startHeight;
      if (Number.isFinite(kx) && Number.isFinite(ky)) {
        pivotKx = kx; pivotKy = ky; originNeedsTracking = true;
      }
    }
  }
  const pivotFor = (rect: { x: number; y: number; width: number; height: number }) => ({
    x: rect.x + pivotKx * rect.width,
    y: rect.y + pivotKy * rect.height,
  });

  // SVG GROUP (an <svg> whose children include <svg>s): each frame we ask the
  // SANDBOX to bake the children's geometry to the current scale SYNCHRONOUSLY
  // (group kept 1:1) so a rotated child stays stable through the drag and on
  // commit (no shear, no mouseup snap). The sandbox owns the group's width/
  // height/viewBox + children atomically, so we skip our own width/height DOM
  // patch for it below (liveStyles still updated for the commit). startWidth/
  // startHeight == the group's original viewBox (it's kept 1:1), so the scale
  // is just newSize/startSize.
  const isBakedGroup = (() => {
    if (isInLayout || !(startWidth > 0) || !(startHeight > 0)) return false;
    // VARIANT tile: the per-tick bake writes SHARED-geometry values (scaled
    // children/viewBox) while the commit routes the group's size to its
    // variant entry as CSS width/height — live ≠ commit (live e2e 2026-06-12:
    // inner `d`s visibly baked mid-gesture, snapped back ~7px on mouse-up).
    // A top-level group is CSS-sized, so plain per-tile width/height patches
    // preview it correctly (children stretch via the viewBox map, composing
    // consistently with any variant-rotated child's own fold).
    if (isComponentFilePath(getActiveFilePath()) && !isPrimaryViewport(vpId)) return false;
    const gNode = getNodeFromCache(nodeId);
    return gNode?.type === 'svg'
      && (gNode.children ?? []).some(cid => getNodeFromCache(cid)?.type === 'svg');
  })();

  // Calculate the fixed point (opposite corner) in parent space
  let fixedPoint: { x: number; y: number } | null = null;

  function recalcFixedPoint(w: number, h: number, l: number, t: number, dir: Direction) {
    if (!hasTransform) return;
    const elementRect = { x: l, y: t, width: w, height: h };
    const oppCorner = getOppositeCorner(dir, { left: l, top: t, width: w, height: h });
    fixedPoint = getTransformedPoint(oppCorner.x, oppCorner.y, elementRect, matrixStr, pivotFor(elementRect));
  }

  let currentDirection = direction;
  recalcFixedPoint(curWidth, curHeight, curLeft, curTop, currentDirection);

  // Node tag name for SVG detection
  const nodeTag = nodeData?.type?.toLowerCase() || '';
  // Viewport frame detection. The parsed JSX for the page root is just
  // `<div data-id="root">` — there's no `data-viewport` attribute in source
  // (the Renderer adds it at paint time, line 572). Relying solely on
  // `nodeAttrs['data-viewport']` therefore missed page roots and the
  // resize fell through to writing `width: '896px'` into the JSX, which is
  // wrong: the page root must stay `width: '100%'` and the viewport
  // breakpoint lives in the `@canvas` comment block. Treat any node whose
  // ID is the canonical viewport-frame ID (`root` or `layout::root`) as a
  // viewport node so the `onViewportResize` branch fires for it too.
  const isVpNode = nodeAttrs['data-viewport'] !== undefined
    || nodeId === 'root'
    || nodeId === 'layout::root';

  trace.action('resize:start', { nodeId, vpId, direction, startWidth, startHeight, hasTransform, pins: inset.pins, insetMode: inset.mode, insetStyles, isCenteredX, isCenteredY, isPercentX, isPercentY });
  onInteracting(true);
  // Mark element-level interaction so consumers like PositionTool's
  // live-poll know to read the bridge rectCache. Cleared in onUp /
  // cancelResize (mirrors the `onInteracting(false)` calls below).
  dragStateOps.set(true);

  // ─── Lift-time local-to-screen basis ─────────────────────────────────────
  // Capture the element's screen-space affine ONCE at resize start
  // and freeze it. The basis vectors (per-unit-of-local-CSS as a
  // screen vector) are INVARIANT under width/height changes — the
  // element's own rotation / scale / 3D transform doesn't change as
  // the user resizes, and resizing just adds more local units to
  // the same basis. Recomputing the basis every frame (what an
  // earlier draft did) caused two problems:
  //
  //   1. cornersCache lags behind live width/height writes by a
  //      frame, so re-reading mid-drag returns transiently stale
  //      corners → wrong basis → wrong delta → cursor races ahead
  //      of the edge, then snaps back, then races, etc.
  //   2. After zero-crossing the geometric basis flips sign,
  //      compounding the error.
  //
  // Freezing the basis at lift sidesteps both. The fallback chain
  // (legacy `getHierarchicalInverseTransformedResizeDeltaById`) only
  // fires if the cache miss makes the snapshot impossible.
  let liftBasis: { ax: number; bx: number; ay: number; by: number } | null = null;
  {
    // SVG GROUP CHILD: the box math runs in the GROUP's user units, so the
    // delta basis is the group's STABLE wrapper map (zoom + real ancestor
    // transforms) — NEVER the child's own corners/matrix. buildParentScreenMap
    // needs offsetWidth (0 on svg) so it nulled out here and every tick fell
    // to the legacy matrix fallback, which divides the mouse delta by the
    // child's OWN painted transform — on a variant child that's the fold being
    // edited (trace 2026-06-12: rawDx −0.5576 → deltaX −0.2490, the exact
    // scaleX 2.2388), and since each tick changes the scale the divisor
    // mutated mid-gesture — the "completely crazy" resize.
    const m = (isSvgGroupChild && nodeData?.parentId)
      ? (() => {
        const gm = buildParentSvgGroupMap(nodeData.parentId!, vpId);
        // VARIANT-ROTATED child: the de-skew machinery (hasTransform) expects
        // mouse deltas in the child's ROTATED LOCAL axes — exactly what HTML
        // rotated elements get from their own corner map. The group map is
        // axis-aligned, so feeding it directly made the top handle move the
        // edge AGAINST the cursor on the replica (live find 2026-06-12).
        // Compose the entry rotation into the basis: localX → R(θ) in group
        // space → screen.
        if (!gm || !isVariantRotatedChild) return gm;
        const r = variantRotateDeg * Math.PI / 180;
        const cos = Math.cos(r), sin = Math.sin(r);
        return {
          ox: gm.ox, oy: gm.oy,
          ux: gm.ux * cos + gm.vx * sin, uy: gm.uy * cos + gm.vy * sin,
          vx: -gm.ux * sin + gm.vx * cos, vy: -gm.uy * sin + gm.vy * cos,
        };
      })()
      : buildParentScreenMap(nodeId, vpId);
    if (m) {
      const det = m.ux * m.vy - m.uy * m.vx;
      if (Math.abs(det) > 1e-9) {
        const invDet = 1 / det;
        liftBasis = {
          ax:  m.vy * invDet, bx: -m.vx * invDet,
          ay: -m.uy * invDet, by:  m.ux * invDet,
        };
      }
    }
    trace.action('resize:lift-basis', {
      hasBasis: !!liftBasis,
      svgGroupChildBasis: isSvgGroupChild,
      cornersOk: !!getScreenCornersById(nodeId, vpId),
      mapOk: !!m,
    });
  }

  // Latches on the first pointermove with actual travel. A plain CLICK on a
  // handle (down + up, no travel) must commit NOTHING: liveStyles still hold
  // the SEEDED base values at that point, and pushing them through the commit
  // re-bakes them — the viewport branch parsed the page root's seeded
  // width:'100%' as 100 and shrank the breakpoint 1440→100 on a bare click.
  let didMove = false;

  // ─── LIVE band-crossing re-render (viewport width drag) ──────────────────
  // Band CSS (@container) responds to the live width continuously for free,
  // but per-viewport VARIANT resolution (responsiveVariantMap — e.g. the
  // template nav's desktop/tablet/mobile variants) and per-viewport PROP
  // styles are resolved at RENDER time into inline styles — so the nav only
  // flipped variants on mouseup. Collect every breakpoint boundary those maps
  // care about; when the dragged width CROSSES one, write the live width into
  // the (in-memory, file-scoped) widths atom and force a mid-gesture render —
  // the tile re-resolves at the crossing width and the nav flips DURING the
  // drag. Crossings are rare (a couple per drag), and gesture-window forced
  // renders ship the imperative node cache, so there's no parse cost.
  const bandCrossingBoundaries: number[] = [];
  if (isVpNode && !isComponentFilePath(getActiveFilePath())) {
    const bounds = new Set<number>();
    for (const n of getAllCachedNodes()) {
      if (n.responsiveVariantMap) {
        for (const k of Object.keys(n.responsiveVariantMap)) {
          const kn = Number(k);
          if (Number.isFinite(kn)) bounds.add(kn);
        }
      }
      if (n.responsivePropStyles) {
        for (const k of Object.keys(n.responsivePropStyles)) {
          const kn = Number(k);
          if (Number.isFinite(kn)) bounds.add(kn);
        }
      }
    }
    bandCrossingBoundaries.push(...[...bounds].sort((a, b) => a - b));
  }
  // Same interval rule as resolve-core.responsiveVariantForWidth: the band a
  // width falls in = smallest boundary ≥ width; above every boundary = null.
  const bandForWidth = (w: number): number | null =>
    bandCrossingBoundaries.find((b) => b >= w) ?? null;
  let lastRenderedBand: number | null = bandForWidth(startWidth);
  let lastBandRenderAt = 0;
  // Viewport-tile chrome (the header pills) hidden for the resize gesture:
  // headers refit from the rect cache, which lags one frame behind the live
  // `left` patches of a west-edge resize — the pill jittered against the
  // stable tile ("viewport header glitches out", 2026-08-07). Hidden lazily
  // on the first vp move tick, restored on every gesture exit. A STYLESHEET
  // rule, not per-element styles: a band-crossing re-render mid-drag re-runs
  // renderViewportHeaders, which REMOVES and RECREATES the pill elements —
  // inline visibility was wiped and the pill popped back mid-gesture
  // ("header only is still glitching", follow-up same day).
  let vpHeadersHidden = false;
  const VP_HEADER_HIDE_ID = 'vp-resize-header-hide';
  const setVpHeadersHidden = (hidden: boolean) => {
    if (hidden === vpHeadersHidden) return;
    vpHeadersHidden = hidden;
    const existing = document.getElementById(VP_HEADER_HIDE_ID);
    if (hidden) {
      if (!existing) {
        const styleEl = document.createElement('style');
        styleEl.id = VP_HEADER_HIDE_ID;
        styleEl.textContent = '[data-viewport-header] { visibility: hidden !important; }';
        document.head.appendChild(styleEl);
      }
    } else {
      existing?.remove();
    }
  };

  // ─── PIN the dragged tile's RESOLUTION WIDTH for the whole gesture ───────
  // The page content of the dragged tile must keep its own responsive state
  // during the drag ("during resize it inherits all the viewport styles",
  // 2026-08-06). Two things were flipping it to desktop mid-drag: the
  // band-crossing re-renders above stamp band state INLINE at the live width,
  // and the raw @container CSS drops bands in/out as the width sweeps
  // intervals. Two-part pin:
  //   1. viewportBandPinOps — every width-keyed resolver (inline band merge,
  //      responsiveVariantMap, responsivePropStyles, conditional text) asks
  //      pinnedResolveWidth() and resolves PAGE nodes at the START width;
  //      template chrome (layout::) deliberately resolves LIVE so nav/footer
  //      keep adapting at crossings ("only the template adjusts").
  //   2. container-type: normal on the dragged tile — silences its raw
  //      @container evaluation so a foreign band (tablet's interval, swept
  //      mid-drag) can't flash over the pinned inline values. The inline
  //      parity merge carries the same values the tile's own band CSS paints,
  //      so nothing shifts visually at suppression time.
  // (An earlier attempt pinned band VALUES as injected !important CSS —
  // defeated by the inline stamps, and it re-applied stale layout:: order
  // rules the Renderer strips: the "footer jumps on mousedown" report.)
  let bandPinActive = false;
  let bandPinVpId = '';
  // Live vw/vh re-resolution for the dragged tile — same helper the SizeTool
  // chevron scrub uses (see viewport-width-scrub.ts). Without it, vh-height
  // sections stay frozen at the start width's simulated-viewport px and jump
  // on the commit render ("big jump on the hero section on mouseup",
  // 2026-08-18).
  let vpUnitLive: { tick(w: number): void } | null = null;
  if (isVpNode && !isComponentFilePath(getActiveFilePath())) {
    const pinVpId = nodeAttrs['data-viewport'] || vpId;
    if (pinVpId) {
      viewportBandPinOps.set(pinVpId, startWidth);
      bandPinVpId = pinVpId;
      vpUnitLive = beginViewportUnitLivePatch(pinVpId, startWidth, nodeId);
      // ONE PINNED RENDER at mousedown — not a bare containerType patch. The
      // standing DOM's inline styles can't be assumed to carry every band
      // value (subtree-skips, pre-band builds), so silencing the tile's
      // container queries alone EXPOSED the primary look the instant the
      // drag started ("on mouse down it goes to start like primary",
      // 2026-08-06). A render with the pin active stamps the pinned band
      // state INLINE on every node AND sets containerType: normal on the
      // pinned tile root (Renderer consult) in the same paint — band CSS
      // hands over to identical inline values atomically.
      forceCanvasRender();
      bandPinActive = true;
      trace.action('resize:viewport-band-pin', { vpId: pinVpId, atWidth: startWidth });
    }
  }
  const removeBandPin = (opts?: { skipDomRestore?: boolean }) => {
    if (!bandPinActive) return;
    bandPinActive = false;
    viewportBandPinOps.clear();
    // The commit path skips the restore — its render (posted right after the
    // pin clear) ships bandPin:null and re-stamps containerType itself, so a
    // manual restore would only re-enable stale bands for a frame.
    if (!opts?.skipDomRestore) {
      patchNodeStyles(contentEl, nodeId, getViewportPrefix(bandPinVpId), { containerType: 'inline-size' });
    }
  };

  const onMove = (e: PointerEvent) => {
    // Mouse delta in screen pixels. The FROZEN lift basis converts
    // it directly into local CSS units (the basis already includes
    // canvas zoom + every ancestor / own transform, 2D and 3D).
    const screenDx = e.clientX - curStartX;
    const screenDy = e.clientY - curStartY;
    if (screenDx !== 0 || screenDy !== 0) didMove = true;

    let deltaX: number, deltaY: number;
    if (liftBasis) {
      deltaX = liftBasis.ax * screenDx + liftBasis.bx * screenDy;
      deltaY = liftBasis.ay * screenDx + liftBasis.by * screenDy;
    } else {
      // Lift-time corners weren't available — fall back to the
      // legacy chain-inversion helper (uses computed transform
      // strings, which don't have the cornersCache lag issue but
      // are wrong for 3D transforms; better than nothing in the
      // degenerate case). For an svg GROUP CHILD start the inversion
      // at the PARENT — the child's OWN transform is the variant fold
      // being edited and must never divide the mouse delta.
      const fallback = getHierarchicalInverseTransformedResizeDeltaById(
        screenDx / canvasScale, screenDy / canvasScale,
        (isSvgGroupChild && nodeData?.parentId) ? nodeData.parentId : nodeId,
        vpId,
      );
      deltaX = fallback.deltaX;
      deltaY = fallback.deltaY;
    }

    let { width: newWidth, height: newHeight, left: newLeft, top: newTop } = calculateResizeDelta(
      curWidth, curHeight, curLeft, curTop,
      deltaX, deltaY, xHandle, yHandle, isInLayout,
    );

    // Aspect ratio lock. A VECTOR SET is ALWAYS locked (any handle, intrinsic
    // ratio) — the reference behaviour. Otherwise Shift on a corner locks to the current
    // ratio. `aspectRatio` == startWidth/startHeight (the vector's intrinsic ratio
    // when undistorted), so the lock keeps it proportional on every resize.
    if (isVectorSet) {
      const locked = applyVectorAspectLock(newWidth, newHeight, curWidth, curHeight, curLeft, curTop, aspectRatio, xHandle, yHandle, isInLayout);
      newWidth = locked.width;
      newHeight = locked.height;
      newLeft = locked.left;
      newTop = locked.top;
    } else if (e.shiftKey && isCorner) {
      const locked = applyAspectRatioLock(newWidth, newHeight, curHeight, curTop, aspectRatio, yHandle, isInLayout);
      newHeight = locked.height;
      newTop = locked.top;
    }

    // ─── Alt — symmetric resize from the centre ──────────────────────
    // Hold Alt while resizing: the element grows / shrinks equally on
    // every side and its centre stays put. A normal resize pins the
    // OPPOSITE edge; Alt pins the centre — each side's delta is applied
    // to BOTH sides and left/top shift back by one delta. Composes with
    // Shift (aspect lock runs first, this doubles the locked dims).
    // Snapping + the corner-pinning transform compensation are skipped
    // below while Alt is held — both assume an anchored edge/corner,
    // which contradicts a centre-anchored resize. Skipped for layout-
    // flow children (no left/top to recentre) and viewport roots.
    const symmetricResize = e.altKey && !isInLayout && !isVpNode;
    if (symmetricResize) {
      const sym = applySymmetricResize(curWidth, curHeight, curLeft, curTop, newWidth, newHeight);
      newWidth = sym.width;
      newHeight = sym.height;
      newLeft = sym.left;
      newTop = sym.top;
    }

    // Zero crossing — detect negative dimensions before compensation.
    // Runs for BOTH corner AND edge handles (not just corners).
    let crossed = false;
    if (xHandle || yHandle) {
      const hadX = xHandle !== null;
      const hadY = yHandle !== null;
      const zc = processZeroCrossing(newWidth, newHeight, newLeft, newTop, xHandle ?? 'right', yHandle ?? 'bottom');
      newWidth = zc.width;
      newHeight = zc.height;
      newLeft = zc.left;
      newTop = zc.top;

      if (zc.crossed) {
        crossed = true;
        // Only update handles that existed — keep null handles null
        if (hadX) xHandle = zc.xHandle;
        if (hadY) yHandle = zc.yHandle;
        currentDirection = updateDirectionAfterCrossing(xHandle ?? zc.xHandle, yHandle ?? zc.yHandle, direction);
      }
    }

    // Min size
    if (newWidth < MIN_SIZE) newWidth = MIN_SIZE;
    if (newHeight < MIN_SIZE) newHeight = MIN_SIZE;

    // ─── Snap resizing edges to siblings + parent walls ───────────────
    // Two paths:
    //   - Axis-aligned (no transform): match layout edges to sibling
    //     AABB edges. Cheap and accurate since layout-box == visual AABB.
    //   - Transformed (rotation/skew): track the visual MOVING point
    //     (layout corner/edge passed through the matrix), snap THAT to
    //     siblings, and inverse-rotate the diagonal back to layout dims.
    //     The transform-compensation step that runs right after re-pins
    //     the opposite visual corner.
    // Two paths: rotated/skewed elements use snapResizeRotated which
    // matches the visual moving point against sibling AABBs and back-
    // solves the layout dim change through the rotation matrix.
    // Non-rotated takes the cheaper AABB path. Both end with transform
    // compensation pinning the opposite corner.
    // Snap path applies to absolute children of a frame AND to top-level
    // canvas nodes (parentId === null). The shared sibling collector
    // (`collectResizeSiblings`) routes the parentless case through
    // `collectTopLevelSnapTargets`, which mirrors what
    // `CanvasDragStrategy` does for top-level drags. Layout flow children
    // and viewport-root resizes still skip snapping (no meaningful
    // siblings to snap against).
    // Relative overlays are EXCLUDED from resize snapping: they live-position
    // from their trigger via computeOverlayPosition, so their box edges have no
    // stable canvas-space relationship to siblings to snap against — guides
    // there are noise. (Trigger-only snapping applies to DRAG, not resize.)
    if (!isInLayout && !isVpNode && !symmetricResize && !isOverlayNode) {
      const txform = transformManager.getTransform();
      if (hasTransform && fixedPoint && matrixStr && matrixStr !== 'none') {
        const snapped = snapResizeRotated(
          newLeft, newTop, newWidth, newHeight,
          xHandle, yHandle, fixedPoint, matrixStr,
          nodeId, vpId, parentId, txform,
        );
        newWidth = snapped.width;
        newHeight = snapped.height;
        callbacks.onSnapGuidesChange?.(snapped.guides);
      } else {
        const snapped = snapResizeEdges(
          newLeft, newTop, newWidth, newHeight,
          xHandle, yHandle, nodeId, vpId, parentId, txform,
        );
        newLeft = snapped.left;
        newTop = snapped.top;
        newWidth = snapped.width;
        newHeight = snapped.height;
        callbacks.onSnapGuidesChange?.(snapped.guides);
      }
    } else {
      callbacks.onSnapGuidesChange?.([]);
    }

    // ─── Transform compensation: pin opposite corner ─────────────────
    // Skipped during a symmetric (Alt) resize — that pins the centre,
    // not a corner, and re-doing the local box around a fixed centre
    // already keeps a centre transform-origin element visually centred.
    if (hasTransform && fixedPoint && !symmetricResize) {
      const newElementRect = { x: newLeft, y: newTop, width: newWidth, height: newHeight };
      const newOppCorner = getOppositeCorner(currentDirection, { left: newLeft, top: newTop, width: newWidth, height: newHeight });
      const newFixedPoint = getTransformedPoint(newOppCorner.x, newOppCorner.y, newElementRect, matrixStr, pivotFor(newElementRect));

      const offsetX = fixedPoint.x - newFixedPoint.x;
      const offsetY = fixedPoint.y - newFixedPoint.y;
      newLeft += offsetX;
      newTop += offsetY;
    }

    // Reset state AFTER both crossing and compensation
    if (crossed) {
      curWidth = newWidth;
      curHeight = newHeight;
      curLeft = newLeft;
      curTop = newTop;
      curStartX = e.clientX;
      curStartY = e.clientY;
      recalcFixedPoint(newWidth, newHeight, newLeft, newTop, currentDirection);
    }

    // A fixed px transform-origin (SVG group, rotating around its painted-
    // content centre) does NOT auto-track the box like `50% 50%` does, so as
    // the box resizes the CSS pivot drifts from the math pivot and the rotated
    // group swings. Keep them locked by patching the origin to the SAME
    // fraction-of-box the compensation uses (kx·W, ky·H). Skipped for centre/%
    // origins (they auto-track). Committed by `normalizeGroupOnResize`.
    if (hasTransform && svgShapeChild && !isVariantRotatedChild) {
      // A single-shape svg pivots at its box CENTRE. Force `50% 50%` (auto-
      // tracking) live so a baked-px origin from an earlier rotate — which on a
      // variant lives in the variants object, invisible to originNeedsTracking —
      // can't drift as the box grows and slide the pinned corner. The math pivot
      // is already box-centre (kx=ky=0.5), so this just keeps CSS == math.
      // (A VARIANT-rotated child keeps its SHARED view-box px carrier — it
      // already equals the math pivot: base-box centre rides the translate.)
      patchNodeStyles(contentEl, nodeId, vpPrefix, { transformBox: 'border-box', transformOrigin: '50% 50%' });
    } else if (hasTransform && originNeedsTracking) {
      // Keep ~3 decimals (not integer) — an integer-rounded origin drifts the
      // pivot off the box centre, making the opposite corner creep on resize.
      patchNodeStyles(contentEl, nodeId, vpPrefix, {
        transformOrigin: `${Math.round(pivotKx * newWidth * 1000) / 1000}px ${Math.round(pivotKy * newHeight * 1000) / 1000}px`,
      });
    }

    // Position formatter. For a ROTATED element keep ~3 decimals: the
    // opposite-corner pin is computed precisely, and integer-rounding left/top
    // shifts the whole (rotated) box ≤0.5px → the "fixed" corner visibly creeps.
    // Un-rotated elements keep integer px (no visible effect, smaller source).
    const posPx = (n: number) => hasTransform ? `${Math.round(n * 1000) / 1000}px` : `${Math.round(n)}px`;

    // Update styles via bridge — pin-aware: update the correct CSS properties.
    // CRITICAL: Only update an axis if the resize handle affects it.
    // Transform compensation can shift newTop/newLeft even for single-axis
    // handle drags — we must NOT propagate those shifts to pinned inset axes.
    const handleAffectsX = xHandle !== null;
    const handleAffectsY = yHandle !== null;

    const prevW = parseFloat(liveStyles.width) || startWidth;
    const prevH = parseFloat(liveStyles.height) || startHeight;
    // Preserve original unit during resize (% stays as %, px stays as px).
    // In inset mode, don't set width/height — CSS derives size from insets.
    // A vector set is aspect-locked, so BOTH axes change on any handle — patch
    // both live (not just the handle's own axis) so it doesn't distort during the
    // drag then snap proportional on mouseup.
    if ((handleAffectsX || isVectorSet) && !inset.horizontalInset) {
      const w = formatResizeDimension(newWidth, origWidthUnit, widthPxPerUnit, parentCssWidth, posPx);
      // Baked group: the sandbox sets the group width atomically with viewBox +
      // children (below), so skip the standalone DOM patch (avoids a 1-frame
      // width/viewBox mismatch = shear). liveStyles still feeds the commit.
      if (!isBakedGroup) patchNodeStyles(contentEl, nodeId, vpPrefix, { width: w });
      liveStyles.width = w;

      // LIVE band crossing (see setup above): the width just moved across a
      // responsiveVariantMap / responsivePropStyles boundary — re-render at
      // the live width so per-viewport variants (template nav) flip DURING
      // the drag, matching what @container band CSS already does live. The
      // widths-atom write is IN-MEMORY only (file+version-scoped override) —
      // the durable config write still happens at commit, and the commit's
      // rewriters key off the CONFIG width, never this transient value.
      // 120ms cooldown so jittering across a boundary can't thrash renders;
      // the next tick past the cooldown catches up, and mouseup re-renders
      // regardless.
      if (isVpNode && bandCrossingBoundaries.length > 0) {
        const band = bandForWidth(newWidth);
        if (band !== lastRenderedBand && performance.now() - lastBandRenderAt > 120) {
          lastRenderedBand = band;
          lastBandRenderAt = performance.now();
          const resizedVpId = nodeAttrs['data-viewport'] || vpId;
          const liveW = Math.round(newWidth);
          // Record the width this render runs at so pinnedResolveWidth can
          // tell the dragged tile apart — page nodes resolve at the pin
          // width, chrome at this live width.
          viewportBandPinOps.updateLiveWidth(liveW);
          getDefaultStore().set(viewportWidthsAtom, (prev) => ({ ...prev, [resizedVpId]: liveW }));
          forceCanvasRender();
          trace.action('resize:viewport-band-crossing-rerender', { vpId: resizedVpId, width: liveW, band });
        }
      }

      // FRAME-PARITY x for viewport tiles: the generic math above already
      // computed the compensated `newLeft` (a west handle anchors the RIGHT
      // edge; zero-crossing flips the anchor) — but a tile's x is its own
      // absolute `left` in canvas space and only `width` was patched, so a
      // west-edge drag grew the tile RIGHTWARD and a flip grew the wrong
      // way ("resize left edge increases the right edge", 2026-08-07).
      // Patch the tile's left live (no-op for east drags — newLeft stays
      // startLeft); the commit persists the final x into @canvas positions
      // via onViewportResize.
      if (isVpNode) {
        vpUnitLive?.tick(newWidth);
        setVpHeadersHidden(true);
        const leftVal = `${Math.round(newLeft)}px`;
        patchNodeStyles(contentEl, nodeId, vpPrefix, { left: leftVal });
        liveStyles.left = leftVal;
      }
    }
    if ((handleAffectsY || isVectorSet) && !inset.verticalInset) {
      const h = formatResizeDimension(newHeight, origHeightUnit, heightPxPerUnit, parentCssHeight, posPx);
      if (!isBakedGroup) patchNodeStyles(contentEl, nodeId, vpPrefix, { height: h });
      liveStyles.height = h;

      // Live-mirror primary viewport height to every replica during drag.
      // The mouseup commit eventually re-renders all viewports from the
      // updated source, but DURING the drag only the dragged element's
      // DOM is patched — without this mirror, tablet/mobile freeze at
      // their pre-drag height for the whole gesture and snap on mouseup.
      // Unconditionally patch every replica's root inline-height here:
      // detached replicas have their own !important @media / inline
      // override that wins in the CSS cascade, so we don't need any
      // detach-detection in the loop.
      //
      // Width is deliberately NOT mirrored — width IS the breakpoint and
      // each viewport's width must stay independent during drag. The
      // surrounding `!isVpNode` branch already handles that for every
      // other style; this is the one targeted exception, for height only.
      if (isVpNode) {
        setVpHeadersHidden(true);
        const allVps = getDefaultStore().get(viewportsConfigAtom);
        const primary = allVps.find(v => v.isPrimary) ?? allVps[0];
        const resizedVpId = nodeAttrs['data-viewport'] || vpId;
        if (primary && primary.id === resizedVpId) {
          for (const replica of allVps) {
            if (replica.id === primary.id) continue;
            const replicaPrefix = replica.id + '-';
            patchNodeStyles(contentEl, nodeId, replicaPrefix, { height: h });
          }
        }
      }
    }

    // SVG GROUP live-baking: one synchronous, atomic sandbox call per frame
    // bakes the group box + viewBox + every child's geometry/pivot to the
    // current scale — identical to the commit, so transformed children stay
    // perfectly stable (no shear, no mouseup snap). startWidth/Height == the
    // group's 1:1 viewBox, so scale = newSize/startSize.
    if (isBakedGroup && startWidth > 0 && startHeight > 0) {
      getCanvasBridge().bakeGroupResize?.(nodeId, vpPrefix, newWidth / startWidth, newHeight / startHeight);
    }

    // SVG inner shape scaling skipped in bridge mode — committed via code generation on resize end.
    // (scaleSvgInnerShape requires direct SVG element access not available across iframe boundary)

    // Overlay live resize: position the box each frame with the SAME pure
    // function the portal renderer applies on commit (computeOverlayPosition),
    // fed the in-progress size. Live geometry therefore equals the mouse-up
    // geometry continuously — center-align grows both sides symmetrically,
    // end-align stays pinned to the trigger's far edge, collision clamps live.
    // Falls back to the generic cursor-anchored left/top when the trigger or
    // root rect isn't in the cache yet.
    if (isCanvasOverlayNode && overlayCfg?.triggerId) {
      // Canvas overlay: reposition in CONTENT-CONTAINER space against its trigger
      // with the in-progress size — the SAME math `positionCanvasNodeOverlays`
      // (and `followCanvasOverlay`) use, so center grows symmetrically / end pins
      // the far edge LIVE, and live == committed (no mouse-up recompensation).
      const scale = transformManager.getTransform().scale;
      const trig = findNodeRect(overlayCfg.triggerId, 'desktop');
      const content = getContentRootRect();
      if (trig && content) {
        const pos = computeOverlayPosition(
          { ...overlayCfg, collision: 'none' }, newWidth, newHeight,
          { left: trig.left, top: trig.top, width: trig.width, height: trig.height,
            right: trig.left + trig.width, bottom: trig.top + trig.height },
          { left: content.left, top: content.top, width: content.width, height: content.height },
          scale,
        );
        patchNodeStyles(contentEl, nodeId, '', {
          left: `${Math.round(pos.left)}px`, top: `${Math.round(pos.top)}px`,
        });
        liveStyles.left = `${Math.round(pos.left)}px`;
        liveStyles.top = `${Math.round(pos.top)}px`;
      }
    } else if (isOverlayNode) {
      const scale = transformManager.getTransform().scale;
      if (overlayCfg?.triggerId) {
        // Recompute the overlay's position in EVERY viewport from its (static)
        // trigger + the in-progress size, with each viewport's RESOLVED config.
        // Doing only the interacting tile made center/end-aligned REPLICAS grow
        // toward one side (size synced but left/top stale) and recenter only on
        // the commit re-render. Each tile re-runs the SAME `computeOverlayPosition`
        // the commit uses, so live == committed in every viewport.
        // ACTIVE viewports — page viewports OR component VARIANTS (so an overlay
        // resize in a variant grows alignment-correctly live, not just on mouse-up).
        const vps = getDefaultStore().get(visibleViewportsAtom);
        const ovRootId = overlayTopLevelAncestor(overlayCfg.triggerId, getDefaultStore().get(nodesAtom));
        for (const vp of vps) {
          const v = vp.id;
          const vPrefix = isPrimaryViewport(v) ? '' : `${v}-`;
          const trig = findNodeRect(overlayCfg.triggerId, v);
          // Component variant root, not hardcoded `root` (else rootR null → skip →
          // top-left-anchored resize until mouse-up).
          const rootR = findNodeRect(ovRootId, v)
            ?? findNodeRect('layout::root', v) ?? findNodeRect('root', v);
          if (!trig || !rootR) continue;
          const cfgV = resolveOverlayConfig(overlayCfg, v, vp.width ?? 0);
          const pos = computeOverlayPosition(
            cfgV, newWidth, newHeight,
            { left: trig.left, top: trig.top, width: trig.width, height: trig.height,
              right: trig.left + trig.width, bottom: trig.top + trig.height },
            { left: rootR.left, top: rootR.top, width: rootR.width, height: rootR.height },
            scale,
            // Component master: overlay overflows over the canvas, not clamped to the variant tile.
            !isComponentFilePath(getActiveFilePath()),
          );
          patchNodeStyles(contentEl, nodeId, vPrefix, {
            left: `${Math.round(pos.left)}px`, top: `${Math.round(pos.top)}px`,
          });
          if (v === vpId) {
            liveStyles.left = `${Math.round(pos.left)}px`;
            liveStyles.top = `${Math.round(pos.top)}px`;
          }
        }
      } else {
        // No trigger — generic cursor-anchored fallback (interacting tile only).
        const overlayPosStyles = { left: `${Math.round(newLeft)}px`, top: `${Math.round(newTop)}px` };
        patchNodeStyles(contentEl, nodeId, vpPrefix, overlayPosStyles);
        liveStyles.left = overlayPosStyles.left;
        liveStyles.top = overlayPosStyles.top;
      }
    } else if (!isInLayout) {
      // Use transform-compensated values (newLeft/newTop/newWidth/newHeight)
      // to compute ALL pinned inset values. Transform compensation ensures
      // the opposite corner stays visually fixed — we then recalculate all
      // pinned sides from the compensated rect.
      // Same approach as old builder's create-resize-handler.tsx.

      const pinnedCount = [inset.pins.left, inset.pins.right, inset.pins.top, inset.pins.bottom].filter(Boolean).length;
      const pW = parentWidth;
      const pH = parentHeight;

      if (pinnedCount >= 2) {
        // Multi-pin: recalculate ALL pinned sides from compensated rect
        const pinStyles: Record<string, string> = {};
        if (inset.pins.left) pinStyles.left = posPx(newLeft);
        if (inset.pins.right) pinStyles.right = posPx(pW - newLeft - newWidth);
        if (inset.pins.top) pinStyles.top = posPx(newTop);
        if (inset.pins.bottom) pinStyles.bottom = posPx(pH - newTop - newHeight);
        patchNodeStyles(contentEl, nodeId, vpPrefix, pinStyles);
        Object.assign(liveStyles, pinStyles);
      } else if (inset.pins.right) {
        const rightVal = posPx(pW - newLeft - newWidth);
        patchNodeStyles(contentEl, nodeId, vpPrefix, { right: rightVal });
        liveStyles.right = rightVal;
      } else if (inset.pins.bottom) {
        const bottomVal = posPx(pH - newTop - newHeight);
        patchNodeStyles(contentEl, nodeId, vpPrefix, { bottom: bottomVal });
        liveStyles.bottom = bottomVal;
      } else if (isFixedLeft) {
        const leftVal = posPx(newLeft);
        patchNodeStyles(contentEl, nodeId, vpPrefix, { left: leftVal });
        liveStyles.left = leftVal;
      } else if (isCenteredX && (handleAffectsX || hasTransform) && !symmetricResize && pW > 0) {
        // Centered x (left:% + translateX(-50%)): reuse the transform-
        // compensated `newLeft` (it already carries the FULL matrix coupling
        // — a rotated element's height resize moves x too, which a
        // handle-axis-only formula missed → per-resize drift, user report
        // 2026-07-29 round 3) and correct for the one thing the compensation
        // gets wrong: it pins against the CONSTANT start matrix (translate
        // baked as −startWidth/2 px) while the browser re-derives −50% of
        // the NEW width. The discrepancy is exactly (newWidth−startWidth)/2,
        // rotation-independent (translation adds after rotation), so:
        // cssLeft = newLeft + (newWidth−startWidth)/2. Continuous through
        // zero-crossing. (Alt/symmetric pins the center — skip; the % stays.)
        const leftVal = `${(((newLeft + (newWidth - startWidth) / 2) / pW) * 100).toFixed(4)}%`;
        patchNodeStyles(contentEl, nodeId, vpPrefix, { left: leftVal });
        liveStyles.left = leftVal;
        wrotePctLeft = true;
      } else if (isPercentX && (handleAffectsX || hasTransform) && pW > 0) {
        // Plain-% left: `newLeft` maps 1:1 to the css value (no size-derived
        // translate) — re-express as %. Also written on transform'd vertical
        // drags: rotation couples height changes into x.
        const leftVal = `${((newLeft / pW) * 100).toFixed(4)}%`;
        patchNodeStyles(contentEl, nodeId, vpPrefix, { left: leftVal });
        liveStyles.left = leftVal;
        wrotePctLeft = true;
      }
      if (!inset.pins.bottom && isFixedTop) {
        const topVal = posPx(newTop);
        patchNodeStyles(contentEl, nodeId, vpPrefix, { top: topVal });
        liveStyles.top = topVal;
      } else if (!inset.pins.bottom && isCenteredY && (handleAffectsY || hasTransform) && !symmetricResize && pH > 0) {
        // Same correction form for a centered y axis (top:% + translateY(-50%)).
        const topVal = `${(((newTop + (newHeight - startHeight) / 2) / pH) * 100).toFixed(4)}%`;
        patchNodeStyles(contentEl, nodeId, vpPrefix, { top: topVal });
        liveStyles.top = topVal;
        wrotePctTop = true;
      } else if (!inset.pins.bottom && isPercentY && (handleAffectsY || hasTransform) && pH > 0) {
        // Plain-% top: same 1:1 re-expression for the vertical axis.
        const topVal = `${((newTop / pH) * 100).toFixed(4)}%`;
        patchNodeStyles(contentEl, nodeId, vpPrefix, { top: topVal });
        liveStyles.top = topVal;
        wrotePctTop = true;
      }
    }

    // Mirror live resize to all viewports via updateNodeStyles domOnly mode.
    // This syncs dimensions (and position for pages) to all replicas via bridge.
    //
    // SKIP for viewport frames: each viewport has an independent breakpoint
    // width — resizing the desktop frame must not visually shrink/grow the
    // tablet/mobile frames mid-drag (the user saw all three viewports
    // tracking the desktop drag, which is wrong). The viewport frame's
    // live dimensions are already applied to its own element by the
    // patchNodeStyles calls above; the cross-viewport mirror would treat
    // the page root as a regular sibling that needs replicas in sync.
    const isComp = isComponentFilePath(getActiveFilePath());
    const syncStyles: Record<string, string> = {};
    if (!isVpNode) {
      if (!isComp && !isOverlayNode) {
        if (liveStyles.left) syncStyles.left = liveStyles.left;
        if (liveStyles.right) syncStyles.right = liveStyles.right;
        if (liveStyles.top) syncStyles.top = liveStyles.top;
        if (liveStyles.bottom) syncStyles.bottom = liveStyles.bottom;
      }
      if (isOverlayNode) {
        // Overlay nodes: sync width/height to replicas (position managed by portal system)
        if (handleAffectsX && liveStyles.width) syncStyles.width = liveStyles.width;
        if (handleAffectsY && liveStyles.height) syncStyles.height = liveStyles.height;
      } else {
        // Only sync dimensions that are ACTUALLY being resized — liveStyles for
        // the non-resized axis contains stale NodeMap values that would revert changes.
        if (handleAffectsX && !inset.horizontalInset && liveStyles.width) syncStyles.width = liveStyles.width;
        if (handleAffectsY && !inset.verticalInset && liveStyles.height) syncStyles.height = liveStyles.height;
      }
    }
    if (Object.keys(syncStyles).length > 0) {
      updateNodeStyles({ id: nodeId, styles: syncStyles, contentEl, domOnly: true });
    }

    // If this resized node is an overlay's trigger, keep the overlay glued to
    // it (all viewports) — reads the trigger's freshly-patched rect.
    updateOverlayFollow();

    // Show dimensions tooltip near cursor with correct, per-axis units. The
    // number must match what gets committed: % is parent-relative, vh/vw/rem/…
    // use the start px↔unit ratio, everything else is px.
    const tooltipDim = (newPx: number, unit: string, pxPerUnit: number, parentCss: number): number =>
      unit === '%' && parentCss > 0 ? Math.round((newPx / parentCss) * 100)
      : unit !== 'px' && pxPerUnit > 0 ? Math.round(newPx / pxPerUnit)
      : Math.round(newPx);
    // VIEWPORT-ROOT resize: the page root's source width is '100%', so the
    // unit-preserving math showed a meaningless percent ("87% × 2564px").
    // What the user is dragging IS the breakpoint — show the pixel width the
    // commit will write into @canvas.
    const isViewportTooltip = isVpNode && !isComponentFilePath(getActiveFilePath());
    const tooltipW = isViewportTooltip
      ? Math.round(newWidth)
      : tooltipDim(newWidth, origWidthUnit, widthPxPerUnit, parentCssWidth);
    const tooltipH = isViewportTooltip
      ? Math.round(newHeight)
      : tooltipDim(newHeight, origHeightUnit, heightPxPerUnit, parentCssHeight);
    styleHelperOps.show({
      type: 'dimensions',
      position: { x: e.clientX, y: e.clientY },
      dimensions: isViewportTooltip
        ? { width: tooltipW, height: tooltipH, unit: 'px', widthUnit: 'px', heightUnit: 'px' }
        : {
            width: tooltipW, height: tooltipH,
            unit: origWidthUnit === '%' || origHeightUnit === '%' ? '%' : 'px',
            widthUnit: origWidthUnit, heightUnit: origHeightUnit,
          },
    });

    // Broadcast the EXACT formatted strings being committed so the Dimensions
    // panel updates live and in-unit (vh/%/px) during the drag — same string
    // the commit writes, so live preview == commit (no mouse-up jump). liveStyles
    // holds the formatted `w`/`h` (and the untouched axis stays at its source).
    resizeLiveOps.set({ nodeId, width: liveStyles.width, height: liveStyles.height });
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    cleanup = null;
    endOverlayFollow(); // commit re-render repositions the overlay from the trigger's final rect
    callbacks.onSnapGuidesChange?.([]);
    // Stop broadcasting live dims — SizeTool's poll holds its last value until the
    // committed styles land (its clear-on-styles-change effect), so no flicker.
    resizeLiveOps.clear();

    // Drop the live group-resize snapshot — the commit below re-renders the
    // group from source (with the identical baked children), invalidating the
    // sandbox's element refs.
    if (isBakedGroup) getCanvasBridge().clearGroupResizeBake?.(nodeId);

    // Zero pointer travel = a click, not a resize. Skip every commit path —
    // no style write, no viewport-config write, no history entry (see the
    // didMove declaration for the viewport 1440→100 shrink this caused).
    // The stale-reveal gates and interaction outline key off the flags
    // cleared here, not off the commit, so plain cleanup is safe.
    if (!didMove) {
      trace.action('resize:end:no-move', { nodeId, vpId });
      removeBandPin(); // no band change happened — safe to drop immediately
      setVpHeadersHidden(false);
      styleHelperOps.hide();
      onInteracting(false);
      dragStateOps.set(false);
      return;
    }

    // Commit — write only the properties that matter for this pin configuration.
    // Overlay nodes: only commit width/height — position is managed by portal system.
    // Commit ONLY the axis this handle actually resized. `liveStyles` is seeded
    // from BASE styles and the non-resized axis is never updated during the
    // move, so writing it would push a stale base value onto a REPLICA —
    // collapsing/reverting its height when you only dragged width. Omitting the
    // untouched axis leaves the replica's own value (or base) intact.
    const finalStyles = isOverlayNode
      ? {
          ...(handleAffectsX ? { width: liveStyles.width || '' } : {}),
          ...(handleAffectsY ? { height: liveStyles.height || '' } : {}),
        }
      : getResizeCommitProperties(
          {
            width: liveStyles.width || '', height: liveStyles.height || '',
            left: liveStyles.left || '', right: liveStyles.right || '',
            top: liveStyles.top || '', bottom: liveStyles.bottom || '',
          },
          inset.pins,
          isInLayout,
          !!isFixedLeft,
          !!isFixedTop,
          !!inset.horizontalInset,
          !!inset.verticalInset,
          isVpNode,
          direction,
          wrotePctLeft,
          wrotePctTop,
        );

    // A VECTOR SET stays aspect-locked, so even an EDGE drag changed BOTH width
    // and height (`applyVectorAspectLock`). `getResizeCommitProperties` only keeps
    // the handle's own axis, so force-commit the OTHER dimension too — else the
    // locked dimension snaps back on mouseup.
    if (isVectorSet) {
      if (liveStyles.width) finalStyles.width = liveStyles.width;
      if (liveStyles.height) finalStyles.height = liveStyles.height;
    }

    // Commit the box-centre pivot for a rotated single-shape svg so a baked-px
    // origin can't survive into the resized box and drift on the NEXT resize.
    // `50% 50%` auto-tracks; routed per-variant by updateNodeStyles below.
    // NOT for a VARIANT-rotated group child: its carrier is the SHARED inline
    // `view-box` + px origin (managed by the geometry channel); this write
    // routed into the VARIANT ENTRY, where motion/the canvas merged
    // `border-box` over the carrier — wrong pivot, ~18px mouse-up snap (live
    // e2e 2026-06-12).
    if (svgShapeChild && hasTransform && !isVariantRotatedChild) {
      (finalStyles as Record<string, string>).transformBox = 'border-box';
      (finalStyles as Record<string, string>).transformOrigin = '50% 50%';
    }

    trace.action('resize:end', { nodeId, vpId, insetMode: inset.mode, ...finalStyles });

    // Viewport root resize: update viewport config width instead of writing @container CSS.
    // Width/height of viewport roots are NOT node styles — they're viewport configuration.
    // The width change updates @container breakpoint boundaries.
    // SKIP for component files — variant roots should update node styles, not viewport config.
    // On component master pages, the root IS a viewport but resize should change the root's width/height.
    const isCompFile = isComponentFilePath(getActiveFilePath());
    if (isVpNode && callbacks.onViewportResize && !isCompFile) {
      const resizedVpId = nodeAttrs['data-viewport'] || vpId;
      // Width comes from finalStyles when this handle resizes the X axis;
      // otherwise fall back to the existing measurement so the callback
      // gets a consistent number even on pure-vertical resize. px ONLY:
      // the page root's base width is '100%' and parseInt('100%') is 100 —
      // a % that leaks this far must fall back to the measured width, not
      // become a 100px breakpoint.
      const newWidth = (finalStyles.width?.endsWith('px') ? parseInt(finalStyles.width) : 0) || curWidth;
      // Height: only forward when the handle actually resizes Y. The
      // callback's contract is that height === 0 means "leave alone";
      // sending the live curHeight on a width-only drag would clobber the
      // user's auto/px choice.
      const newHeight = handleAffectsY ? (parseInt(finalStyles.height) || curHeight) : 0;
      // Final tile x — a west-edge (or zero-crossing-flipped) drag moved the
      // tile's `left` live; persist it into @canvas positions or the commit
      // re-render snaps the tile back to its old x. East drags pass the
      // unchanged startLeft (idempotent).
      const newX = handleAffectsX && liveStyles.left?.endsWith('px')
        ? Math.round(parseFloat(liveStyles.left)) : undefined;
      if (resizedVpId && newWidth > 0) {
        // Clear the pin BEFORE the commit: the commit's forceCanvasRender then
        // ships bandPin:null — the sandbox store clears, resolvers resolve at
        // the FINAL width, and the root's containerType is re-stamped to
        // inline-size by the render itself (no manual restore needed).
        removeBandPin({ skipDomRestore: true });
        setVpHeadersHidden(false);
        callbacks.onViewportResize(resizedVpId, newWidth, newHeight, newX);
        styleHelperOps.hide();
        onInteracting(false);
        dragStateOps.set(false);
        return; // Don't commit any styles for viewport root resize
      }
    }
    removeBandPin(); // fall-through safety — vp branch above didn't fire
    setVpHeadersHidden(false);

    // Capture variant position BEFORE committing (liveStyles has the updated left/top from resize)
    let pendingVariantPos: { variantName: string; x: number; y: number } | null = null;
    if (isCompFile && isVpNode && callbacks.onVariantPositionUpdate) {
      const variantVpId = nodeAttrs['data-viewport'] || vpId;
      pendingVariantPos = {
        variantName: variantVpId === 'desktop' ? 'default' : variantVpId,
        x: Math.round(parseFloat(liveStyles.left) || 0),
        y: Math.round(parseFloat(liveStyles.top) || 0),
      };
    }

    // Icon-set master: when resizing a VARIANT CONTAINER
    // (a direct child of master root listed in iconConfig),
    // position + size live in the config
    // array, NOT inline JSX styles. Without this intercept, the
    // standard `updateNodeStyles` below writes width/height to the
    // JSX, the parser-merge pass overrides them with the still-old
    // config values, and the variant snaps back to its pre-resize
    // size on mouseup. Mirror the drag-commit interceptor in
    // Canvas.tsx (`commitDragUpdates`) so resize and drag share the
    // same source-of-truth for these masters.
    const ap = getActiveFilePath();
    const isIconMaster = isIconSetFilePath(ap);
    let routedToConfig = false;
    if (isIconMaster) {
      const code = projectFS.readFile(ap) || '';
      const variantConfigs = parseIconSetConfig(code);
      const variantNames = new Set(variantConfigs.map(c => c.name));
      if (variantNames.has(nodeId)) {
        // Route position writes (top-left handles can shift left/top
        // during a resize, e.g. dragging the topLeft handle moves the
        // anchor). Only write the keys that actually appear in
        // finalStyles — pin-aware commit may have stripped some.
        // Keep the CURRENT config value for any axis the resize didn't touch
        // (a `|| 0` fallback once wrote width:0 and COLLAPSED the variant) AND
        // for any non-px value (percent misread as px = the mouse-up jump
        // bug — see iconConfigPx).
        const cur = variantConfigs.find(c => c.name === nodeId);
        if (finalStyles.left !== undefined || finalStyles.top !== undefined) {
          const x = iconConfigPx(finalStyles.left, cur?.x ?? 0);
          const y = iconConfigPx(finalStyles.top, cur?.y ?? 0);
          updateIconPosition(ap, nodeId, x, y);
        }
        if (finalStyles.width !== undefined || finalStyles.height !== undefined) {
          const w = iconConfigPx(finalStyles.width, cur?.width ?? 0);
          const h = iconConfigPx(finalStyles.height, cur?.height ?? 0);
          updateIconSize(ap, nodeId, w, h);
        }
        const freshCode = projectFS.readFile(ap);
        if (freshCode) syncQueueCode(freshCode);
        // domOnly: keep the live DOM in sync with the config we just
        // wrote, but DON'T write inline styles to the source file.
        // Mirrors the drag path's domOnly trick — without it the DOM
        // still shows the OLD geometry until the next parser-driven
        // re-render, producing a one-frame revert flicker.
        const domSync: Record<string, string> = {};
        for (const k of ['left', 'top', 'width', 'height'] as const) {
          if (finalStyles[k] !== undefined) domSync[k] = finalStyles[k];
        }
        if (Object.keys(domSync).length > 0) {
          updateNodeStyles({ id: nodeId, styles: domSync, contentEl, domOnly: true });
        }
        // Other style keys (rare on a resize, but possible if
        // pin-aware commit added something extra) still flow through
        // the regular write so they land in the JSX. Strip the
        // routed-to-config keys before that write.
        const otherStyles: Record<string, string> = {};
        for (const [k, v] of Object.entries(finalStyles)) {
          if (k === 'left' || k === 'top' || k === 'width' || k === 'height') continue;
          otherStyles[k] = v;
        }
        if (Object.keys(otherStyles).length > 0) {
          updateNodeStyles({ id: nodeId, styles: otherStyles, contentEl });
        }
        routedToConfig = true;
        trace.action('resize:routed-to-container-set-config', {
          nodeId,
          kind: 'icon',
          finalStyles,
        });
      }
    }

    if (!routedToConfig) {
      // NOTE: position (left/top) is intentionally kept here — for a component variant root the
      // per-variant code routing (replica-context / variantConfig) needs it. The one-frame
      // "all variant tiles jump to the primary's position" glitch is prevented at the correct
      // layer: `updateNodeStyles`'s component-primary fan-out no longer mirrors POSITION keys to
      // sibling variant tiles (each variant owns its own position — see node-ops.ts).
      updateNodeStyles({ id: nodeId, styles: finalStyles, contentEl });
    }
    styleHelperOps.hide();
    onInteracting(false);
    dragStateOps.set(false);

    // Update variantConfig position AFTER cleanup so re-renders don't interrupt resize state
    if (pendingVariantPos && callbacks.onVariantPositionUpdate) {
      callbacks.onVariantPositionUpdate(pendingVariantPos.variantName, pendingVariantPos.x, pendingVariantPos.y);
    }
  };

  // If the RESIZED node is an overlay's trigger, glue the overlay to it live
  // (every viewport) while resizing — same mechanism as the drag path. No-op
  // when the resized node isn't a trigger (e.g. resizing the overlay itself).
  beginOverlayFollow(getDefaultStore().get(nodesAtom), [nodeId], contentEl);

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    endOverlayFollow();
    removeBandPin(); // cancel path — never leave gesture-scoped CSS behind
    setVpHeadersHidden(false);
    onInteracting(false);
    dragStateOps.set(false);
    // Drop the bake snapshot on cancel too — a stale one would corrupt the
    // next resize of the same group (it'd reuse the old original geometry).
    if (isBakedGroup) getCanvasBridge().clearGroupResizeBake?.(nodeId);
  };
}

function cancelResize(): void {
  if (cleanup) { cleanup(); cleanup = null; }
}
