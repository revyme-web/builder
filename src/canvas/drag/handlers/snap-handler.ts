// snap-handler.ts — Calculate snap alignment during drag.
// Pure functions: dragged rect + sibling rects → snapped position + guide lines + spacing bands.
//
// Features:
// 1. Edge/center alignment snap (left, centerX, right, top, centerY, bottom)
// 2. Same-size detection — when sibling has matching width/height, show 3 guides (both edges + center)
// 3. Equal-spacing distance bands — detect equal gaps, show pink bands with px labels
// 4. Transform-aware corner snapping — rotated/skewed elements snap by their visual
//    corners (computed via marker-DOM technique in the bridge), not just the AABB
// 5. Corridor-trap prevention — once snapped, only re-snap to the SAME position
//    (sticky zone). Prevents catching adjacent edges when breaking free.

import type { Rect, SnapGuide, SnapResult, SpacingGuide, SpacingSegment, Point } from '@/shared/types';
import { SNAP_THRESHOLD, SNAP_BREAKOUT_SPEED } from '@/shared/constants';

/** Four screen-space corners of a (possibly rotated) element. */
export interface ScreenCorners {
  TL: { x: number; y: number };
  TR: { x: number; y: number };
  BR: { x: number; y: number };
  BL: { x: number; y: number };
}

interface SnapCandidate {
  axis: 'x' | 'y';
  position: number;
  type: 'edge' | 'center';
  referenceId: string;
  distance: number;
  /** The drag-side coordinate that's snapping to `position`. Stored so
   *  the back-shift uses the EXACT anchor that generated this candidate
   *  (e.g. a specific rotated corner), not the closest of a generic
   *  anchor set — adding AABB anchors alongside corner anchors would
   *  otherwise produce wrong shifts when the AABB center happens to
   *  sit nearer to the snap target than the originating corner. */
  anchor: number;
}

// ─── Snap Hysteresis State ───────────────────────────────────────────────────
// Once snapped, require higher velocity to break free. This prevents jittering
// at the snap boundary when the user is trying to stay snapped.

/** Whether X axis was snapped in the previous frame */
let hadActiveSnapX = false;
/** Whether Y axis was snapped in the previous frame */
let hadActiveSnapY = false;
/** Exact X position we're snapped to (for corridor-trap prevention) */
let lastSnapPosX = 0;
/** Exact Y position we're snapped to */
let lastSnapPosY = 0;

/** Reset snap hysteresis state (call when drag ends/cancels) */
export function resetSnapHysteresis(): void {
  hadActiveSnapX = false;
  hadActiveSnapY = false;
  lastSnapPosX = 0;
  lastSnapPosY = 0;
}

/** Ruler guide as a snap target. `position` is canvas-space CSS px
 *  (same units as `draggedRect.left/top` and `siblingRects[].rect`),
 *  matching how the guides are stored in `ruler-guides-config.ts`'s
 *  annotation block. */
export interface RulerGuideSnapLine {
  id: string;
  axis: 'x' | 'y';
  position: number;
}

/**
 * Calculate snap alignment for a dragged rectangle against sibling rectangles.
 *
 * Optional `dragCorners` / `siblingCorners` enable transform-aware snapping:
 * for rotated/skewed elements, the AABB right/bottom edges are misleading —
 * the visual corners are what should align with siblings. Corners come from
 * the bridge's `cornersCache` (populated via the marker-DOM technique inside
 * the iframe; see canvas-sandbox/bridge-sandbox.ts).
 *
 * Optional `rulerGuides` adds the user's persistent ruler guides as snap
 * targets. Each vertical guide contributes 3 X-axis candidates (left/center/
 * right edge of the dragged element snapping to the guide's canvas-x); each
 * horizontal guide does the symmetric Y-axis variant. Rotated elements add
 * one candidate per visible corner instead of AABB edges (same rule the
 * sibling-snap path uses).
 */
export function calculateSnap(
  draggedRect: Rect,
  siblingRects: { id: string; rect: Rect }[],
  mouseVelocity: number = 0,
  threshold: number = SNAP_THRESHOLD,
  dragCorners?: ScreenCorners | null,
  siblingCorners?: Map<string, ScreenCorners>,
  rulerGuides?: RulerGuideSnapLine[],
): SnapResult {
  const empty: SnapResult = {
    x: draggedRect.left, y: draggedRect.top,
    snappedX: false, snappedY: false,
    guides: [], spacingGuides: [],
  };

  // When currently snapped, require higher velocity to break free (1.5x breakout speed).
  // When not snapped, use normal breakout speed threshold.
  const isCurrentlySnapped = hadActiveSnapX || hadActiveSnapY;
  const effectiveBreakout = isCurrentlySnapped ? SNAP_BREAKOUT_SPEED * 1.5 : SNAP_BREAKOUT_SPEED;
  if (mouseVelocity > effectiveBreakout) {
    hadActiveSnapX = false;
    hadActiveSnapY = false;
    lastSnapPosX = 0;
    lastSnapPosY = 0;
    return empty;
  }

  // True rotation detection. dragCorners is passed even for non-rotated
  // elements (the strategy passes them for transform-aware snap), so we
  // must inspect the corner geometry: an axis-aligned rect has TL.y ==
  // TR.y, BL.y == BR.y, TL.x == BL.x, TR.x == BR.x. Anything else means
  // the element is actually transformed.
  const isActuallyRotated = !!dragCorners && (
    Math.abs(dragCorners.TL.y - dragCorners.TR.y) > 0.5 ||
    Math.abs(dragCorners.BL.y - dragCorners.BR.y) > 0.5 ||
    Math.abs(dragCorners.TL.x - dragCorners.BL.x) > 0.5 ||
    Math.abs(dragCorners.TR.x - dragCorners.BR.x) > 0.5
  );

  const candidates: SnapCandidate[] = [];

  // Effective AABB of the dragged element. For rotated elements,
  // `draggedRect.left/top/width/height` mixes the CSS box top-left with
  // the rotated AABB width — not a coherent rect. Derive the AABB from
  // the corner quad when corners are present so edges/center actually
  // match the visible bounding box the user sees (selection handles
  // sit on this AABB; snap should align to it). For non-rotated
  // elements the corner AABB equals draggedRect — same numbers.
  let dragLeft: number;
  let dragRight: number;
  let dragTop: number;
  let dragBottom: number;
  if (dragCorners) {
    const xs = [dragCorners.TL.x, dragCorners.TR.x, dragCorners.BR.x, dragCorners.BL.x];
    const ys = [dragCorners.TL.y, dragCorners.TR.y, dragCorners.BR.y, dragCorners.BL.y];
    dragLeft = Math.min(...xs);
    dragRight = Math.max(...xs);
    dragTop = Math.min(...ys);
    dragBottom = Math.max(...ys);
  } else {
    dragLeft = draggedRect.left;
    dragRight = draggedRect.left + draggedRect.width;
    dragTop = draggedRect.top;
    dragBottom = draggedRect.top + draggedRect.height;
  }
  const dragCenterX = (dragLeft + dragRight) / 2;
  const dragCenterY = (dragTop + dragBottom) / 2;

  // (No separate `dragXPts/dragYPts` arrays needed — each candidate
  // carries the originating anchor via `SnapCandidate.anchor`, and
  // the back-shift below uses that exact value. This avoids the bug
  // where adding AABB anchors alongside corner anchors caused the
  // back-shift to pick a closer-but-wrong anchor for a snap candidate
  // generated from a different drag-side point.)

  for (const { id, rect } of siblingRects) {
    const sibLeft = rect.left;
    const sibCenterX = rect.left + rect.width / 2;
    const sibRight = rect.left + rect.width;
    const sibTop = rect.top;
    const sibCenterY = rect.top + rect.height / 2;
    const sibBottom = rect.top + rect.height;

    // AABB drag-source candidates (edges + center) — fire for ALL
    // elements. For rotated elements, `dragLeft/Right/Top/Bottom` were
    // derived above from the corner AABB (the visible selection box
    // the user sees), so these candidates align with what they see on
    // screen. For non-rotated elements, the values come straight from
    // `draggedRect`.
    //
    // X-axis (vertical guide lines): AABB edges + center
    addCandidate(candidates, 'x', sibLeft,    'edge',   id, dragLeft);
    addCandidate(candidates, 'x', sibLeft,    'edge',   id, dragRight);
    addCandidate(candidates, 'x', sibCenterX, 'center', id, dragCenterX);
    addCandidate(candidates, 'x', sibRight,   'edge',   id, dragLeft);
    addCandidate(candidates, 'x', sibRight,   'edge',   id, dragRight);

    // Y-axis (horizontal guide lines): AABB edges + center
    addCandidate(candidates, 'y', sibTop,     'edge',   id, dragTop);
    addCandidate(candidates, 'y', sibTop,     'edge',   id, dragBottom);
    addCandidate(candidates, 'y', sibCenterY, 'center', id, dragCenterY);
    addCandidate(candidates, 'y', sibBottom,  'edge',   id, dragTop);
    addCandidate(candidates, 'y', sibBottom,  'edge',   id, dragBottom);

    // Transform-aware: corner ↔ sibling-edge and corner ↔ corner.
    // Only run these when something IS actually transformed (dragged or
    // sibling). For non-rotated-on-non-rotated, the AABB candidates above
    // already cover everything — adding redundant corner candidates here
    // creates duplicates that compete with the AABB winners and produce
    // visible jumps as small mouse movements flip which one is closest.
    const sc = siblingCorners?.get(id);
    const sibIsRotated = !!sc && (
      Math.abs(sc.TL.y - sc.TR.y) > 0.5 ||
      Math.abs(sc.BL.y - sc.BR.y) > 0.5 ||
      Math.abs(sc.TL.x - sc.BL.x) > 0.5 ||
      Math.abs(sc.TR.x - sc.BR.x) > 0.5
    );
    if (sc && (isActuallyRotated || sibIsRotated)) {
      for (const sp of [sc.TL, sc.TR, sc.BR, sc.BL]) {
        // dragAABB-edge ↔ sibling-corner — only when dragged isn't rotated
        if (!isActuallyRotated) {
          addCandidate(candidates, 'x', sp.x, 'edge', id, dragLeft);
          addCandidate(candidates, 'x', sp.x, 'edge', id, dragRight);
          addCandidate(candidates, 'y', sp.y, 'edge', id, dragTop);
          addCandidate(candidates, 'y', sp.y, 'edge', id, dragBottom);
        }
        // dragCorner ↔ sibling-corner — only when dragged IS rotated
        if (isActuallyRotated && dragCorners) {
          for (const dp of [dragCorners.TL, dragCorners.TR, dragCorners.BR, dragCorners.BL]) {
            addCandidate(candidates, 'x', sp.x, 'edge', id, dp.x);
            addCandidate(candidates, 'y', sp.y, 'edge', id, dp.y);
          }
        }
      }
    }
    // dragCorner ↔ sibling-AABB-edge — only relevant when dragged IS rotated
    if (isActuallyRotated && dragCorners) {
      for (const dp of [dragCorners.TL, dragCorners.TR, dragCorners.BR, dragCorners.BL]) {
        addCandidate(candidates, 'x', sibLeft,  'edge', id, dp.x);
        addCandidate(candidates, 'x', sibRight, 'edge', id, dp.x);
        addCandidate(candidates, 'y', sibTop,    'edge', id, dp.y);
        addCandidate(candidates, 'y', sibBottom, 'edge', id, dp.y);
      }
    }
  }

  // ─── Ruler guides as snap targets ─────────────────────────────────────
  // Each guide is a single canvas-space line (no width/height), so it
  // contributes ONE snap position on its axis. The dragged element can
  // hit it with any of its three X (or Y) anchor points — left/center/
  // right (top/center/bottom) — same set the sibling-edge candidates
  // use. `referenceId` is prefixed with `ruler-guide:` so consumers
  // (drop-line indicator, etc.) can tell ruler-guide hits from
  // sibling-edge hits if they ever need to style them differently.
  if (rulerGuides && rulerGuides.length > 0) {
    for (const g of rulerGuides) {
      const refId = `ruler-guide:${g.id}`;
      if (g.axis === 'x') {
        // AABB edge + center anchors for ALL elements (rotated AABB
        // derived from corners above; non-rotated uses draggedRect).
        addCandidate(candidates, 'x', g.position, 'edge',   refId, dragLeft);
        addCandidate(candidates, 'x', g.position, 'edge',   refId, dragRight);
        addCandidate(candidates, 'x', g.position, 'center', refId, dragCenterX);
        // Rotated → also let actual corners snap to the guide so a
        // user can pin a specific rotated corner to a ruler line.
        if (isActuallyRotated && dragCorners) {
          for (const dp of [dragCorners.TL, dragCorners.TR, dragCorners.BR, dragCorners.BL]) {
            addCandidate(candidates, 'x', g.position, 'edge', refId, dp.x);
          }
        }
      } else {
        addCandidate(candidates, 'y', g.position, 'edge',   refId, dragTop);
        addCandidate(candidates, 'y', g.position, 'edge',   refId, dragBottom);
        addCandidate(candidates, 'y', g.position, 'center', refId, dragCenterY);
        if (isActuallyRotated && dragCorners) {
          for (const dp of [dragCorners.TL, dragCorners.TR, dragCorners.BR, dragCorners.BL]) {
            addCandidate(candidates, 'y', g.position, 'edge', refId, dp.y);
          }
        }
      }
    }
  }

  // Find best snap for each axis. Once snapped, only consider candidates at
  // the SAME position we're already stuck to (corridor-trap prevention) — when
  // the user breaks free we don't want to immediately catch the next edge.
  const xCandidates = candidates.filter(c => c.axis === 'x');
  const yCandidates = candidates.filter(c => c.axis === 'y');
  const baseThreshold = threshold;
  const stickyThreshold = threshold * 2;
  let bestX: SnapCandidate | null;
  let bestY: SnapCandidate | null;
  if (hadActiveSnapX) {
    bestX = findBestSnap(xCandidates.filter(c => Math.abs(c.position - lastSnapPosX) < 0.5), stickyThreshold);
    if (!bestX) { hadActiveSnapX = false; bestX = findBestSnap(xCandidates, baseThreshold); }
  } else {
    bestX = findBestSnap(xCandidates, baseThreshold);
  }
  if (hadActiveSnapY) {
    bestY = findBestSnap(yCandidates.filter(c => Math.abs(c.position - lastSnapPosY) < 0.5), stickyThreshold);
    if (!bestY) { hadActiveSnapY = false; bestY = findBestSnap(yCandidates, baseThreshold); }
  } else {
    bestY = findBestSnap(yCandidates, baseThreshold);
  }

  let snappedLeft = draggedRect.left;
  let snappedTop = draggedRect.top;

  if (bestX) {
    // Shift `draggedRect.left` by the delta needed to bring the
    // originating anchor onto the snap target. The anchor came in
    // canvas-coords (rotated AABB or specific corner), so this delta
    // applies equally to the input rect — the whole element moves
    // rigidly by the same amount.
    snappedLeft += bestX.position - bestX.anchor;
  }

  if (bestY) {
    snappedTop += bestY.position - bestY.anchor;
  }

  // Build the snapped rect for same-size and spacing calculations
  const snappedRect: Rect = {
    left: snappedLeft, top: snappedTop,
    width: draggedRect.width, height: draggedRect.height,
  };

  // ─── Collect guides ────────────────────────────────────────────────────

  const guides: SnapGuide[] = [];

  if (bestX) {
    // Check for same-size snap (3 lines)
    const sameSizeGuides = detectSameSize('x', snappedRect, siblingRects, bestX.referenceId, threshold);
    if (sameSizeGuides.length > 0) {
      guides.push(...sameSizeGuides);
    } else {
      guides.push({ axis: 'x', position: bestX.position, type: bestX.type, referenceId: bestX.referenceId });
    }
  }

  if (bestY) {
    const sameSizeGuides = detectSameSize('y', snappedRect, siblingRects, bestY.referenceId, threshold);
    if (sameSizeGuides.length > 0) {
      guides.push(...sameSizeGuides);
    } else {
      guides.push({ axis: 'y', position: bestY.position, type: bestY.type, referenceId: bestY.referenceId });
    }
  }

  // ─── Equal spacing detection ───────────────────────────────────────────

  const spacingGuides = detectEqualSpacing(snappedRect, siblingRects, threshold);

  // Check if spacing snap should override position
  if (spacingGuides.length > 0) {
    for (const sg of spacingGuides) {
      if (sg._snapX !== undefined && !bestX) {
        snappedLeft = sg._snapX;
      }
      if (sg._snapY !== undefined && !bestY) {
        snappedTop = sg._snapY;
      }
    }
  }

  const resultSnappedX = !!bestX || spacingGuides.some(s => s._snapX !== undefined);
  const resultSnappedY = !!bestY || spacingGuides.some(s => s._snapY !== undefined);

  // Update hysteresis state for next frame
  hadActiveSnapX = resultSnappedX;
  hadActiveSnapY = resultSnappedY;
  if (bestX) lastSnapPosX = bestX.position;
  if (bestY) lastSnapPosY = bestY.position;

  return {
    x: snappedLeft,
    y: snappedTop,
    snappedX: resultSnappedX,
    snappedY: resultSnappedY,
    guides,
    spacingGuides: spacingGuides.map(({ _snapX, _snapY, ...sg }) => sg),
  };
}

// ─── Same-Size Detection (3 lines) ──────────────────────────────────────────

/**
 * When the dragged element aligns with a sibling that has the SAME width (x-axis)
 * or SAME height (y-axis), AND their edges actually line up on that axis,
 * return 3 guide lines: both edges + center.
 *
 * The key condition: both left AND right edges must be within tolerance (not just width match).
 * This means the elements are truly vertically/horizontally aligned, not just same size.
 */
function detectSameSize(
  axis: 'x' | 'y',
  snappedRect: Rect,
  siblings: { id: string; rect: Rect }[],
  snappedSiblingId: string,
  threshold: number,
): SnapGuide[] {
  const sibling = siblings.find(s => s.id === snappedSiblingId);
  if (!sibling) return [];

  const sib = sibling.rect;
  const EDGE_TOLERANCE = threshold; // both edges must align within snap threshold

  if (axis === 'x') {
    // Check: left edges aligned AND right edges aligned (= same width + same horizontal position)
    const leftAligned = Math.abs(snappedRect.left - sib.left) <= EDGE_TOLERANCE;
    const rightAligned = Math.abs((snappedRect.left + snappedRect.width) - (sib.left + sib.width)) <= EDGE_TOLERANCE;

    if (!leftAligned || !rightAligned) return [];

    return [
      { axis: 'x', position: sib.left, type: 'edge', referenceId: snappedSiblingId },
      { axis: 'x', position: sib.left + sib.width / 2, type: 'center', referenceId: snappedSiblingId },
      { axis: 'x', position: sib.left + sib.width, type: 'edge', referenceId: snappedSiblingId },
    ];
  } else {
    // Check: top edges aligned AND bottom edges aligned
    const topAligned = Math.abs(snappedRect.top - sib.top) <= EDGE_TOLERANCE;
    const bottomAligned = Math.abs((snappedRect.top + snappedRect.height) - (sib.top + sib.height)) <= EDGE_TOLERANCE;

    if (!topAligned || !bottomAligned) return [];

    return [
      { axis: 'y', position: sib.top, type: 'edge', referenceId: snappedSiblingId },
      { axis: 'y', position: sib.top + sib.height / 2, type: 'center', referenceId: snappedSiblingId },
      { axis: 'y', position: sib.top + sib.height, type: 'edge', referenceId: snappedSiblingId },
    ];
  }
}

// ─── Equal Spacing Detection (Distance Bands) ──────────────────────────────

interface SpacingGuideInternal extends SpacingGuide {
  _snapX?: number;
  _snapY?: number;
}

/**
 * Detect equal spacing between adjacent siblings.
 * When the dragged element can maintain equal gaps, show pink distance bands.
 */
function detectEqualSpacing(
  draggedRect: Rect,
  siblings: { id: string; rect: Rect }[],
  threshold: number,
): SpacingGuideInternal[] {
  const results: SpacingGuideInternal[] = [];
  if (siblings.length < 2) return results;

  // ─── Horizontal spacing (elements side-by-side) ──────────────────────
  const hSorted = [...siblings].sort((a, b) => a.rect.left - b.rect.left);
  const hGaps = collectGaps(hSorted, 'h', draggedRect);
  const hSpacing = findEqualSpacingMatch(hGaps, draggedRect, 'h', threshold);
  if (hSpacing) results.push(hSpacing);

  // ─── Vertical spacing (elements stacked) ─────────────────────────────
  const vSorted = [...siblings].sort((a, b) => a.rect.top - b.rect.top);
  const vGaps = collectGaps(vSorted, 'v', draggedRect);
  const vSpacing = findEqualSpacingMatch(vGaps, draggedRect, 'v', threshold);
  if (vSpacing) results.push(vSpacing);

  return results;
}

interface Gap {
  distance: number;
  start: number;      // end of first element
  end: number;        // start of second element
  crossMin: number;
  crossMax: number;
  aRect: Rect;
  bRect: Rect;
}

function collectGaps(
  sorted: { id: string; rect: Rect }[],
  axis: 'h' | 'v',
  draggedRect: Rect,
): Gap[] {
  const gaps: Gap[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i].rect;
    const b = sorted[i + 1].rect;

    if (axis === 'h') {
      const gap = b.left - (a.left + a.width);
      if (gap <= 0) continue; // overlapping
      if (gap > 500) continue; // too far apart, not a meaningful gap

      // Check cross-axis overlap between the TWO siblings (not requiring dragged to overlap)
      const overlapTop = Math.max(a.top, b.top);
      const overlapBottom = Math.min(a.top + a.height, b.top + b.height);
      if (overlapBottom - overlapTop < 1) continue;

      gaps.push({
        distance: gap,
        start: a.left + a.width,
        end: b.left,
        crossMin: Math.min(a.top, b.top),
        crossMax: Math.max(a.top + a.height, b.top + b.height),
        aRect: a, bRect: b,
      });
    } else {
      const gap = b.top - (a.top + a.height);
      if (gap <= 0) continue;
      if (gap > 500) continue;

      const overlapLeft = Math.max(a.left, b.left);
      const overlapRight = Math.min(a.left + a.width, b.left + b.width);
      if (overlapRight - overlapLeft < 1) continue;

      gaps.push({
        distance: gap,
        start: a.top + a.height,
        end: b.top,
        crossMin: Math.min(a.left, b.left),
        crossMax: Math.max(a.left + a.width, b.left + b.width),
        aRect: a, bRect: b,
      });
    }
  }

  return gaps;
}

function findEqualSpacingMatch(
  gaps: Gap[],
  draggedRect: Rect,
  axis: 'h' | 'v',
  threshold: number,
): SpacingGuideInternal | null {
  if (gaps.length === 0) return null;

  // Check each gap: can the dragged element extend the pattern?
  for (const gap of gaps) {
    const d = gap.distance;

    if (axis === 'h') {
      // Can dragged element be placed to the LEFT of the first element with same gap?
      const idealLeftOfA = gap.aRect.left - d - draggedRect.width;
      const distLeft = Math.abs(draggedRect.left - idealLeftOfA);

      // Can dragged element be placed to the RIGHT of the second element with same gap?
      const idealRightOfB = gap.bRect.left + gap.bRect.width + d;
      const distRight = Math.abs(draggedRect.left - idealRightOfB);

      if (distLeft <= threshold) {
        // Snap to left of A with same gap
        const segments: SpacingSegment[] = [
          // Gap between dragged and A
          { start: idealLeftOfA + draggedRect.width, end: gap.aRect.left, crossMin: gap.crossMin, crossMax: gap.crossMax },
          // Original gap between A and B
          { start: gap.start, end: gap.end, crossMin: gap.crossMin, crossMax: gap.crossMax },
        ];
        return { axis: 'h', distance: d, segments, _snapX: idealLeftOfA };
      }

      if (distRight <= threshold) {
        const segments: SpacingSegment[] = [
          { start: gap.start, end: gap.end, crossMin: gap.crossMin, crossMax: gap.crossMax },
          { start: gap.bRect.left + gap.bRect.width, end: idealRightOfB, crossMin: gap.crossMin, crossMax: gap.crossMax },
        ];
        return { axis: 'h', distance: d, segments, _snapX: idealRightOfB };
      }

      // Can dragged element fit IN the gap (centered)?
      if (draggedRect.width < d) {
        const idealCenter = gap.start + (d - draggedRect.width) / 2;
        const distCenter = Math.abs(draggedRect.left - idealCenter);
        if (distCenter <= threshold) {
          const segments: SpacingSegment[] = [
            { start: gap.start, end: idealCenter, crossMin: gap.crossMin, crossMax: gap.crossMax },
            { start: idealCenter + draggedRect.width, end: gap.end, crossMin: gap.crossMin, crossMax: gap.crossMax },
          ];
          return { axis: 'h', distance: Math.round((d - draggedRect.width) / 2), segments, _snapX: idealCenter };
        }
      }
    } else {
      // Vertical — same logic on Y axis
      const idealAboveA = gap.aRect.top - d - draggedRect.height;
      const distAbove = Math.abs(draggedRect.top - idealAboveA);

      const idealBelowB = gap.bRect.top + gap.bRect.height + d;
      const distBelow = Math.abs(draggedRect.top - idealBelowB);

      if (distAbove <= threshold) {
        const segments: SpacingSegment[] = [
          { start: idealAboveA + draggedRect.height, end: gap.aRect.top, crossMin: gap.crossMin, crossMax: gap.crossMax },
          { start: gap.start, end: gap.end, crossMin: gap.crossMin, crossMax: gap.crossMax },
        ];
        return { axis: 'v', distance: d, segments, _snapY: idealAboveA };
      }

      if (distBelow <= threshold) {
        const segments: SpacingSegment[] = [
          { start: gap.start, end: gap.end, crossMin: gap.crossMin, crossMax: gap.crossMax },
          { start: gap.bRect.top + gap.bRect.height, end: idealBelowB, crossMin: gap.crossMin, crossMax: gap.crossMax },
        ];
        return { axis: 'v', distance: d, segments, _snapY: idealBelowB };
      }

      if (draggedRect.height < d) {
        const idealCenter = gap.start + (d - draggedRect.height) / 2;
        const distCenter = Math.abs(draggedRect.top - idealCenter);
        if (distCenter <= threshold) {
          const segments: SpacingSegment[] = [
            { start: gap.start, end: idealCenter, crossMin: gap.crossMin, crossMax: gap.crossMax },
            { start: idealCenter + draggedRect.height, end: gap.end, crossMin: gap.crossMin, crossMax: gap.crossMax },
          ];
          return { axis: 'v', distance: Math.round((d - draggedRect.height) / 2), segments, _snapY: idealCenter };
        }
      }
    }
  }

  return null;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function addCandidate(
  candidates: SnapCandidate[],
  axis: 'x' | 'y',
  position: number,    // sibling-side target position
  type: 'edge' | 'center',
  referenceId: string,
  anchor: number,      // drag-side coordinate that wants to snap to `position`
) {
  candidates.push({
    axis,
    position,
    type,
    referenceId,
    distance: Math.abs(anchor - position),
    anchor,
  });
}

function findBestSnap(
  candidates: SnapCandidate[],
  threshold: number,
): SnapCandidate | null {
  let best: SnapCandidate | null = null;
  for (const c of candidates) {
    if (c.distance > threshold) continue;
    if (!best || c.distance < best.distance) best = c;
  }
  return best;
}

/**
 * Calculate mouse velocity from two consecutive positions.
 */
export function getMouseVelocity(prev: Point, current: Point): number {
  const dx = current.x - prev.x;
  const dy = current.y - prev.y;
  return Math.sqrt(dx * dx + dy * dy);
}
