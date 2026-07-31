// dynamic-pin.ts — standard auto-pin assignment for absolute elements.
//
// While dragging an unlocked absolute child inside a parent, we pick how
// to anchor it based on where it sits. The chosen pins drive
// `left/right/top/bottom` inline writes — same idea as the reference's "bold pin
// flicker" during drag.
//
// PARENT TYPE matters:
//   • Viewport parent (the page/layout root — `parent.parentId === null`):
//       Y is ALWAYS `top-px`. Elements never auto-pin to bottom because
//       pages can scroll arbitrarily — a bottom pin against the viewport
//       would jump as the page grows. Only the X axis uses the 3-band
//       rule.
//   • Frame parent (any positioned/relative container — `parent.parentId
//     !== null`):
//       Both axes use the 3-band rule independently. Center of frame →
//       fully-percent on both axes (free position, no pin). Bottom-band →
//       auto-pins to bottom-px without any snap gesture.
//
// 3-BAND RULE (per axis, keyed on the child's CENTER position):
//   Band 1 (start third): start-px (`left` or `top` in px)
//   Band 2 (middle third): start-percent (`left: P%` / `top: P%` —
//     element flexes with parent, no opposite-edge pin)
//   Band 3 (end third):
//     • X axis: start-px BY DEFAULT. Switches to `right-px` ONLY when
//       the strategy reports `snappedToRightEdge: true` — a snap-to-
//       right gesture promotes the pin. Pure position doesn't.
//     • Y axis (frame parents only): always `bottom-px` — no snap
//       needed, automatic.
//
// Lock contract: a node with `data-pinned="true"` in its source attrs is
// USER-PINNED and this function is NOT used for it — the strategy keeps
// the existing inset logic. The attribute is reset on re-parent / unparent
// so the dynamic flow resumes.

/** X-axis pin choice — drives which inline property the strategy writes. */
type XPin =
  | 'left-px'      // cs.left = Npx, cs.right = ''
  | 'left-percent' // cs.left = P%, cs.right = ''
  | 'right-px';    // cs.right = Npx, cs.left = '' (snap-to-right only)

/** Y-axis pin choice — viewport parents always get 'top-px'; frame
 *  parents pick across all three. */
type YPin =
  | 'top-px'        // cs.top = Npx, cs.bottom = ''
  | 'top-percent'   // cs.top = P%, cs.bottom = '' (frame parent middle band)
  | 'bottom-px';    // cs.bottom = Npx, cs.top = '' (frame parent bottom band)

export interface AutoPinResult {
  /** Horizontal pin choice. */
  x: XPin;
  /** Vertical pin choice. */
  y: YPin;
}

/** Decide which pins to assign to an element on each axis based on its
 *  current parent-local rect.
 *
 *  Inputs are in CSS px in parent-local coords (same space as the
 *  strategy's `newLeft/Top + element size`). All four parent-inner
 *  edges are at `0..parentInnerWidth/Height`.
 *
 *  `snappedToRightEdge` is set by the strategy when the element's right
 *  edge has snapped to the parent's right inner edge — only in this case
 *  does the X pin become `right-px` (band 3 only).
 *
 *  `parentIsViewport` toggles between the two rule sets above. */
export function computeAutoPins(
  childLeft: number,
  childTop: number,
  childWidth: number,
  childHeight: number,
  parentInnerWidth: number,
  parentInnerHeight: number,
  snappedToRightEdge: boolean = false,
  parentIsViewport: boolean = false,
): AutoPinResult {
  return {
    x: pickXPin(childLeft, childWidth, parentInnerWidth, snappedToRightEdge),
    y: parentIsViewport
      ? 'top-px'  // viewport rule: always top (never bottom — pages scroll)
      : pickYPin(childTop, childHeight, parentInnerHeight),
  };
}

function pickXPin(
  childLeft: number,
  childWidth: number,
  parentInnerWidth: number,
  snappedToRightEdge: boolean,
): XPin {
  if (parentInnerWidth <= 0) return 'left-px';
  // Hard overflow: element bigger than parent on this axis. The right-
  // pin formula `cs.right = parentW - childLeft - childWidth` goes
  // negative AND the element can't fit, so the only sensible anchor
  // is `left-px`.
  if (childWidth >= parentInnerWidth) return 'left-px';

  // 3 equal bands keyed on the child's CENTER x (not its left edge).
  // Center-based banding avoids flicker when a wide element straddles
  // band boundaries.
  const childCenter = childLeft + childWidth / 2;
  const bandWidth = parentInnerWidth / 3;
  const inBand1 = childCenter < bandWidth;
  const inBand3 = childCenter >= bandWidth * 2;

  if (inBand1) return 'left-px';
  if (inBand3) {
    if (!snappedToRightEdge) return 'left-px';
    // Soft overflow: snap-right was requested but the right edge of
    // the element sticks past the parent's right edge (childLeft +
    // childWidth > parentW). `cs.right` would be negative — element
    // would render shifted LEFT by the overflow amount, producing the
    // visible jump on entry into a small container. Fall back to
    // left-px so the element stays anchored where the user dragged it.
    const csRight = parentInnerWidth - childLeft - childWidth;
    if (csRight < 0) return 'left-px';
    return 'right-px';
  }
  // Band 2 (middle third) → left in %, free horizontal.
  return 'left-percent';
}

function pickYPin(
  childTop: number,
  childHeight: number,
  parentInnerHeight: number,
): YPin {
  if (parentInnerHeight <= 0) return 'top-px';
  if (childHeight >= parentInnerHeight) return 'top-px';

  const childCenter = childTop + childHeight / 2;
  const bandHeight = parentInnerHeight / 3;
  const inBand1 = childCenter < bandHeight;
  const inBand3 = childCenter >= bandHeight * 2;

  if (inBand1) return 'top-px';
  if (inBand3) {
    // Soft overflow guard: even when childHeight < parentInnerHeight,
    // the bottom-px formula `cs.bottom = parentH - childTop -
    // childHeight` can go negative when the element's bottom edge
    // sticks past the parent's bottom (childTop + childHeight >
    // parentH). CSS interprets a negative `bottom` as "element bottom
    // sits N px BELOW parent bottom" — the element renders shifted
    // UPWARD by the overflow amount, exactly the visible jump users
    // see when dragging into a cell that's slightly smaller than the
    // element. Fall back to top-px so the element keeps the
    // cursor-anchored top position.
    const csBottom = parentInnerHeight - childTop - childHeight;
    if (csBottom < 0) return 'top-px';
    return 'bottom-px';
  }
  // Band 2 (middle third) → top in %, free vertical.
  return 'top-percent';
}
