// pin-field-resize.ts — what a T/L/R/B value in the Position panel commits.
//
// The rule, from the user: the fields must do exactly what dragging the
// matching resize handle does. The ResizeManager already solves every hard
// case — rotation, the opposite edge staying fixed, which inset properties an
// element actually uses — so this module reuses its parts rather than
// inventing a parallel model:
//
//   • `edgeValueResize` — the edited edge lands on the typed value AND the
//     opposite edge stays VISUALLY fixed, solved as one system. On a
//     transformed element those are different constraints: the transform
//     pivots about the box centre, and the centre moves when the size changes,
//     so holding the CSS side fixed makes a rotated element slide along its
//     own axis (user report 2026-09-20). Solving them one after the other is
//     worse still — the second breaks the first, the committed value never
//     matches the typed one, and the field runs away on every keystroke.
//   • `liveInsetWrites` — the axis rules for WHICH sides to write, byte for
//     byte what `ResizeManager` calls on every frame of a handle drag.
//
// Three earlier attempts at this, each wrong in an instructive way:
//   1. write the bare property → `bottom` is dead against `top` + `height`,
//      so nothing moved and the pin badge lied about it;
//   2. swap the axis (pin the typed side, clear its opposite) → the box jumped,
//      because the element re-anchored;
//   3. make it an inset (add the side, drop the dimension) → correct CSS, but
//      the size then derives from the parent, so replica viewports with a
//      narrower parent collapsed the node to zero width and it vanished;
//   4. resize with the anchor applied AFTER the sizing → a feedback loop that
//      drove a 195px box past 500px in a few chevron clicks.
// A resize does none of those: it keeps the dimension explicit, keeps the
// existing pins, and just changes the size. Replicas keep mirroring because
// the width/height are still px.

import { getPinState } from '@/shared/pin-utils';
import { liveInsetWrites } from '@/canvas/resize/live-inset-writes';
import { compensatedEdgeResize, translateOffsetPx, type LayoutBox, type ResizeEdge } from '@/canvas/resize/size-input-compensation';

export type PinSide = 'left' | 'right' | 'top' | 'bottom';

export const oppositeSide = (side: PinSide): PinSide =>
  side === 'left' ? 'right' : side === 'right' ? 'left' : side === 'top' ? 'bottom' : 'top';

export const isHorizontalSide = (side: PinSide): boolean => side === 'left' || side === 'right';

const has = (v: string | undefined) => !!v && v.trim() !== '' && v.trim() !== 'auto';
const isPct = (v: string | undefined) => !!v && /%\s*$/.test(v.trim());

/** `-50%` centering on one axis, in either the `translate(x, y)` or the
 *  `translateX(…)` / `translateY(…)` form. */
export function centersOn(transform: string | undefined, axis: 'x' | 'y'): boolean {
  if (!transform) return false;
  if (axis === 'x') {
    if (/translateX\(\s*-50%/.test(transform)) return true;
    return /translate\(\s*-50%/.test(transform);
  }
  if (/translateY\(\s*-50%/.test(transform)) return true;
  return /translate\([^,)]+,\s*-50%/.test(transform);
}

/**
 * Which property positions an axis, as CSS resolves it. `top` + `height` makes
 * `bottom` inert, whatever the panel's pin badge says — that inertness was the
 * original bug. An axis with both sides and NO size is an inset: both live.
 */
export function axisMode(
  styles: Record<string, string>,
  horiz: boolean,
): { driver: PinSide | null; inset: boolean } {
  const startSide: PinSide = horiz ? 'left' : 'top';
  const endSide: PinSide = horiz ? 'right' : 'bottom';
  const sizeKey = horiz ? 'width' : 'height';
  const hasStart = has(styles[startSide]);
  const hasEnd = has(styles[endSide]);
  if (hasStart && hasEnd && !has(styles[sizeKey])) return { driver: null, inset: true };
  if (hasStart) return { driver: startSide, inset: false };
  if (hasEnd) return { driver: endSide, inset: false };
  return { driver: null, inset: false };
}

export interface PinFieldEdit {
  side: PinSide;
  /** The typed value resolved to px. */
  valuePx: number;
  /** The value this field held before the edit — the step is `valuePx - basePx`.
   *  A RESIZE is driven by that DELTA, never by the absolute target: solving for
   *  "the size that puts this inset at X while the opposite edge holds" is
   *  ill-conditioned near 180° (gain (d−1)/(1+d)), which is what sent a 2px edit
   *  300px sideways and then to the 0xFFFFFF clamp. A delta is exact at every
   *  angle, and it is what the pointer supplies to ResizeManager. */
  basePx: number;
  /** Effective styles, as the panel sees them. */
  styles: Record<string, string>;
  /** Layout box as painted (parent space, rotation already undone). */
  box: LayoutBox | null;
  parentWidth: number;
  parentHeight: number;
  /** Computed transform matrix, for the rotation anchor. */
  matrixStr: string;
}

/** `${n}px`, at the resize commit's precision. */
const px = (n: number) => `${Math.round(n * 100) / 100}px`;

/**
 * The styles to write for one pin-field edit.
 *
 * MOVE — the edited side already drives its axis, alone: the element slides,
 * its size is untouched, and a single property is written. A pure translation
 * needs no transform compensation (the box and its pivot move together).
 *
 * RESIZE — the edited side does NOT drive its axis, or the axis is an inset:
 * the opposite edge is fixed and this edge moves, so the SIZE changes. That is
 * a handle drag, and it goes through the handle's own math.
 */
export function pinFieldEditWrite(e: PinFieldEdit): Record<string, string> {
  const { side, valuePx, basePx, styles, box, parentWidth, parentHeight, matrixStr } = e;
  const horiz = isHorizontalSide(side);
  const { driver, inset } = axisMode(styles, horiz);

  // EVERY field is its handle. There is no resize handle that moves the whole
  // box, so no field does either: T moves the top edge with the bottom held,
  // exactly as B moves the bottom edge with the top held (user report
  // 2026-09-20: "i increase top toolinput and the whole frame moves instead of
  // resizing like B does"). The anchor is the opposite EDGE, which exists
  // geometrically whether or not that side is declared in the source.
  //
  // The one exception is an axis with nothing declared: there is no edge to
  // anchor against yet, so the value simply positions it.
  if (!inset && driver === null) {
    return { [side]: px(valuePx) };
  }

  if (!box) return { [side]: px(valuePx) };

  const parentSize = horiz ? parentWidth : parentHeight;
  if (!(parentSize > 0)) return { [side]: px(valuePx) };

  // ONE STEP of the edge, as a pointer would deliver it. Growing the inset
  // shrinks the box: the edge moves inward by exactly the step.
  const size = horiz ? box.width : box.height;
  const newSize = size - (valuePx - basePx);
  const resized = compensatedEdgeResize(
    box,
    side as ResizeEdge,
    horiz ? newSize : box.width,
    horiz ? box.height : newSize,
    matrixStr,
  );

  // CSS insets exclude the translate; the box includes it, at the NEW size.
  const cssLeft = resized.left - translateOffsetPx(styles.transform, 'x', resized.width);
  const cssTop = resized.top - translateOffsetPx(styles.transform, 'y', resized.height);

  const pins = getPinState(styles);
  const hasTransform = has(styles.transform) && styles.transform !== 'none';
  const w = liveInsetWrites({
    pins,
    isFixedLeft: has(styles.left) && !isPct(styles.left),
    isFixedTop: has(styles.top) && !isPct(styles.top),
    isCenteredX: isPct(styles.left) && centersOn(styles.transform, 'x'),
    isCenteredY: isPct(styles.top) && centersOn(styles.transform, 'y'),
    isPercentX: isPct(styles.left),
    isPercentY: isPct(styles.top),
    handleAffectsX: horiz,
    handleAffectsY: !horiz,
    hasTransform,
    symmetricResize: false,
    pW: parentWidth,
    pH: parentHeight,
    newLeft: cssLeft,
    newTop: cssTop,
    newWidth: resized.width,
    newHeight: resized.height,
    startWidth: box.width,
    startHeight: box.height,
    posPx: px,
  });

  const out: Record<string, string> = { ...w.styles };
  // An inset axis derives its size — writing one would break the inset. Every
  // other case keeps the dimension explicit, so replicas keep mirroring it.
  if (!inset) out[horiz ? 'width' : 'height'] = px(Math.max(0, horiz ? resized.width : resized.height));
  // The edited side is NOT written when the source does not already pin it:
  // against `top` + `height` a `bottom` declaration is inert CSS, and writing
  // it only lights the pin badge for a pin that does nothing — the original
  // complaint. Its value is expressed through the size, and the field reads it
  // back from the box. `liveInsetWrites` writes exactly the sides that were
  // already pinned, which is what the handle drag does.
  return out;
}
