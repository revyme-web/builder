// size-input-compensation.ts — typing a Width / Height into the Dimensions
// panel on a TRANSFORMED absolute element behaves like the ResizeManager's
// bottom-right handle: the element's own top-left corner (in its rotated
// frame) stays visually fixed, exactly as a handle drag pins the opposite
// corner. Before (2026-09-08) the panel wrote the bare width/height, so with
// transform-origin at the centre a 90°-rotated bar slid along its axis on
// every value change.
//
// Same model as ResizeManager's transform compensation (canvas-math
// getTransformedPoint): with pivot P (box centre) and 2×2 matrix M, the visual
// position of a layout point q is P + M·(q − P). Keep the visual top-left
// fixed across the size change → solve for the new layout left/top.

export interface LayoutBox { left: number; top: number; width: number; height: number }

export function parseMatrix2D(matrixStr: string | undefined | null): { a: number; b: number; c: number; d: number } | null {
  if (!matrixStr || matrixStr === 'none') return null;
  const m = matrixStr.match(/matrix\(([-\d.e+]+),\s*([-\d.e+]+),\s*([-\d.e+]+),\s*([-\d.e+]+),\s*([-\d.e+]+),\s*([-\d.e+]+)\)/);
  if (!m) return null;
  return { a: parseFloat(m[1]), b: parseFloat(m[2]), c: parseFloat(m[3]), d: parseFloat(m[4]) };
}

/** Rotation / skew / flip present (a pure translate or scale needs no compensation). */
export function needsSizeCompensation(matrixStr: string | undefined | null): boolean {
  const m = parseMatrix2D(matrixStr);
  if (!m) return false;
  return Math.abs(m.b) > 1e-6 || Math.abs(m.c) > 1e-6 || m.a < 0 || m.d < 0;
}

function visualPoint(x: number, y: number, box: LayoutBox, m: { a: number; b: number; c: number; d: number }): { x: number; y: number } {
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const dx = x - cx, dy = y - cy;
  return { x: cx + m.a * dx + m.c * dy, y: cy + m.b * dx + m.d * dy };
}

/** New layout left/top for the resized box such that the VISUAL top-left
 *  corner stays where it was. `box` is the current layout box (CSS px, parent
 *  space, as painted — i.e. including any translate). */
export function compensatedSizeInput(box: LayoutBox, newWidth: number, newHeight: number, matrixStr: string): { left: number; top: number; width: number; height: number } {
  // ZERO CROSSING (the resize handle's rule): a size driven past 0 mirrors
  // the box across the anchored edge — the ORIGINAL top-left corner stays
  // put and becomes the box's top-right (or bottom-left) corner. CSS has no
  // negative size; the chevron scrub used to write `-34px` (2026-09-09).
  const mirrorX = newWidth < 0;
  const mirrorY = newHeight < 0;
  const w = Math.abs(newWidth);
  const h = Math.abs(newHeight);
  const m = parseMatrix2D(matrixStr) ?? { a: 1, b: 0, c: 0, d: 1 };
  const fixed = visualPoint(box.left, box.top, box, m);
  const trial: LayoutBox = { left: mirrorX ? box.left - w : box.left, top: mirrorY ? box.top - h : box.top, width: w, height: h };
  // The corner of the NEW box that must land on the old visual top-left.
  const anchorX = mirrorX ? trial.left + w : trial.left;
  const anchorY = mirrorY ? trial.top + h : trial.top;
  const moved = visualPoint(anchorX, anchorY, trial, m);
  return { left: trial.left + (fixed.x - moved.x), top: trial.top + (fixed.y - moved.y), width: w, height: h };
}

/** The edge a single-edge resize holds fixed (`getOppositeCorner`'s edge cases). */
export type ResizeEdge = 'top' | 'bottom' | 'left' | 'right';

/** Max gain on the anchored side: |1+d| = 0.5 (±120°) allows at most 3×. */
const MIN_CONDITION = 0.5;

/**
 * The layout box after moving ONE edge to a target inset, with the opposite
 * edge held VISUALLY fixed — a single-edge handle drag, driven by a typed
 * value instead of a pointer.
 *
 * Both conditions are solved TOGETHER, and that is the whole point. Doing them
 * in sequence — size the box from the old anchor, then shift it for the visual
 * anchor — breaks the first condition with the second, so the committed inset
 * never equals the typed one; the field re-reads a different number and the
 * next keystroke compounds it. That ran a 195px box up past 500px in a few
 * chevron clicks (user report 2026-09-20, "CRAZY numbers like 4000PX height").
 *
 * With pivot at the box centre and matrix [a b; c d], for a BOTTOM edit:
 *   (i)  top' + h' = K,             K = parentHeight − target
 *   (ii) top' + h'(1−d)/2 = top + h(1−d)/2      (visual top-edge midpoint held)
 * ⇒ h' = [2(K − top) − (1−d)h] / (1+d),  top' = K − h',
 *   left' = left + c(h' − h)/2      (holding the same point's x)
 * Each case collapses to the plain formula when d = 1 (no rotation).
 *
 * Returns null when the solve is ILL-CONDITIONED, which is the case that bit:
 * the anchored side moves by (d−1)/(1+d) per unit of the typed value, so as the
 * rotation approaches 180° the gain runs away — at 190° (a rectangle that looks
 * like 10°) d ≈ −0.985 and a 2px edit threw `top` by ~300px, then to the
 * 0xFFFFFF clamp. It is not merely numerical: at 180° the VISUAL top edge IS
 * the layout bottom edge, so "hold the visual top edge while moving the layout
 * bottom" asks for two different values of one quantity.
 *
 * Past the threshold the caller falls back to the plain layout-space edit —
 * which at 180° is exactly right anyway, since holding layout `top` there holds
 * the visual BOTTOM edge, the correct opposite edge for a flipped box.
 */
/**
 * The layout box after a single-edge resize to a known new size, with the
 * opposite edge held VISUALLY fixed. This is the handle's own rule, and unlike
 * `edgeValueResize` it is well conditioned at EVERY angle, because the size is
 * an input rather than something solved for. Feed it a per-step delta and it
 * behaves like a pointer drag.
 */
export function compensatedEdgeResize(
  box: LayoutBox,
  edge: ResizeEdge,
  newWidth: number,
  newHeight: number,
  matrixStr: string,
): LayoutBox {
  const horiz = edge === 'left' || edge === 'right';
  const signed = horiz ? newWidth : newHeight;
  // ZERO CROSSING — the handle's rule (`processZeroCrossing`, and the mirror in
  // `compensatedSizeInput`): a size driven past 0 does not stop at 0, it MIRRORS
  // across the anchored edge and keeps growing the other way. Clamping instead
  // made the box stall on 0 and then jump (user report 2026-09-20: "it does a
  // jump and keeps doing jumps instead of just smoothly reverting").
  const mirrored = signed < 0;
  const size = Math.abs(signed);
  const w = horiz ? size : box.width;
  const h = horiz ? box.height : size;

  // Normally the box grows FROM the anchored edge; mirrored, it grows through
  // it and out the other side, so the anchored coordinate becomes the far edge.
  let left = box.left;
  let top = box.top;
  if (edge === 'left') left = mirrored ? box.left + box.width : box.left + box.width - w;
  else if (edge === 'right') left = mirrored ? box.left - w : box.left;
  else if (edge === 'top') top = mirrored ? box.top + box.height : box.top + box.height - h;
  else top = mirrored ? box.top - h : box.top;
  const trial: LayoutBox = { left, top, width: w, height: h };

  const m = parseMatrix2D(matrixStr);
  if (!m || !needsSizeCompensation(matrixStr)) return trial;
  // The anchored edge's midpoint. In a mirrored box that physical edge is the
  // OPPOSITE named edge, so the same point is held either way.
  const midOf = (b: LayoutBox, which: ResizeEdge) => {
    switch (which) {
      case 'top':    return { x: b.left + b.width / 2, y: b.top };
      case 'bottom': return { x: b.left + b.width / 2, y: b.top + b.height };
      case 'left':   return { x: b.left, y: b.top + b.height / 2 };
      case 'right':  return { x: b.left + b.width, y: b.top + b.height / 2 };
    }
  };
  const opposite = oppositeEdge(edge);
  const a0 = midOf(box, opposite);
  const a1 = midOf(trial, mirrored ? edge : opposite);
  const fixed = visualPoint(a0.x, a0.y, box, m);
  const moved = visualPoint(a1.x, a1.y, trial, m);
  return { ...trial, left: trial.left + (fixed.x - moved.x), top: trial.top + (fixed.y - moved.y) };
}

const oppositeEdge = (e: ResizeEdge): ResizeEdge =>
  e === 'left' ? 'right' : e === 'right' ? 'left' : e === 'top' ? 'bottom' : 'top';

export function edgeValueResize(
  box: LayoutBox,
  edge: ResizeEdge,
  targetInset: number,
  parentWidth: number,
  parentHeight: number,
  matrixStr: string,
): LayoutBox | null {
  const m = parseMatrix2D(matrixStr) ?? { a: 1, b: 0, c: 0, d: 1 };
  const { a, b, c, d } = m;
  const horiz = edge === 'left' || edge === 'right';
  const denom = horiz ? 1 + a : 1 + d;
  if (Math.abs(denom) < MIN_CONDITION) return null;

  let left = box.left, top = box.top, width = box.width, height = box.height;
  switch (edge) {
    case 'bottom': {
      const K = parentHeight - targetInset;
      height = (2 * (K - box.top) - (1 - d) * box.height) / denom;
      top = K - height;
      left = box.left + (c * (height - box.height)) / 2;
      break;
    }
    case 'top': {
      height = box.height + (2 * (box.top - targetInset)) / denom;
      top = targetInset;
      left = box.left + (c * (box.height - height)) / 2;
      break;
    }
    case 'right': {
      const K = parentWidth - targetInset;
      width = (2 * (K - box.left) - (1 - a) * box.width) / denom;
      left = K - width;
      top = box.top + (b * (width - box.width)) / 2;
      break;
    }
    case 'left': {
      width = box.width + (2 * (box.left - targetInset)) / denom;
      left = targetInset;
      top = box.top + (b * (box.width - width)) / 2;
      break;
    }
  }
  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  return { left, top, width, height };
}

/** Existing translate offset in px for the NEW size (a `-50%` scales with the box). */
export function translateOffsetPx(transform: string | undefined, axis: 'x' | 'y', size: number): number {
  if (!transform) return 0;
  const pair = transform.match(/translate\(\s*([^,)]+)(?:,\s*([^)]+))?\)/i);
  const single = axis === 'x' ? transform.match(/translateX\(\s*([^)]+)\)/i) : transform.match(/translateY\(\s*([^)]+)\)/i);
  const raw = single ? single[1].trim() : pair ? (axis === 'x' ? pair[1] : (pair[2] ?? '0')).trim() : null;
  if (!raw) return 0;
  if (/%$/.test(raw)) return (parseFloat(raw) / 100) * size || 0;
  return parseFloat(raw) || 0;
}

export interface SizeInputWriteArgs {
  /** SOURCE styles — the original box is derived from these, never from the
   *  DOM: the chevron scrub has already patched the DOM width live by the
   *  time the commit runs, so a DOM-measured box is post-change and the
   *  compensation collapses to a no-op (2026-09-08, second report). */
  styles: Record<string, string>;
  parentWidth: number;
  parentHeight: number;
  /** Computed transform matrix string. */
  matrixStr: string;
  axis: 'width' | 'height';
  /** The typed value, px (already resolved from % by the caller when needed). */
  newValue: number;
  /** The value to WRITE for the axis — the typed string in its own unit
   *  ('35%' stays a %); defaults to `newValue` px. */
  writeValue?: string;
  /** Fallback for anything the source can't answer (auto size, no inset). */
  fallbackBox?: LayoutBox;
}

const isPx = (v: string | undefined) => !!v && /^-?[\d.]+px$/.test(v.trim());
const isPct = (v: string | undefined) => !!v && /^-?[\d.]+%$/.test(v.trim());
const num = (v: string | undefined) => parseFloat(v ?? '') || 0;

/** The ORIGINAL layout box (CSS px, parent space, as PAINTED = with translate)
 *  from the source styles. Exported for the tests. */
export function sourceLayoutBox(styles: Record<string, string>, parentWidth: number, parentHeight: number, fallback?: LayoutBox): LayoutBox | null {
  // Source size: px, or % of the parent (the Dimensions unit toggle).
  const w = isPx(styles.width) ? num(styles.width) : isPct(styles.width) ? (num(styles.width) / 100) * parentWidth : fallback?.width;
  const h = isPx(styles.height) ? num(styles.height) : isPct(styles.height) ? (num(styles.height) / 100) * parentHeight : fallback?.height;
  if (!(w! > 0) || !(h! > 0)) return null;
  const tx = translateOffsetPx(styles.transform, 'x', w!);
  const ty = translateOffsetPx(styles.transform, 'y', h!);
  let cssLeft: number | undefined;
  if (isPx(styles.left)) cssLeft = num(styles.left);
  else if (isPct(styles.left)) cssLeft = (num(styles.left) / 100) * parentWidth;
  else if (isPx(styles.right)) cssLeft = parentWidth - num(styles.right) - w!;
  else if (isPct(styles.right)) cssLeft = parentWidth - (num(styles.right) / 100) * parentWidth - w!;
  else if (fallback) cssLeft = fallback.left - tx;
  let cssTop: number | undefined;
  if (isPx(styles.top)) cssTop = num(styles.top);
  else if (isPct(styles.top)) cssTop = (num(styles.top) / 100) * parentHeight;
  else if (isPx(styles.bottom)) cssTop = parentHeight - num(styles.bottom) - h!;
  else if (isPct(styles.bottom)) cssTop = parentHeight - (num(styles.bottom) / 100) * parentHeight - h!;
  else if (fallback) cssTop = fallback.top - ty;
  if (cssLeft == null || cssTop == null) return null;
  return { left: cssLeft + tx, top: cssTop + ty, width: w!, height: h! };
}

/**
 * The style write for a Dimensions-panel size change on a transformed
 * absolute element: the new size plus the insets that keep the element's
 * VISUAL top-left fixed (the resize handle's opposite-corner rule). Every
 * positioning form the builder writes is re-expressed: px left/top, px
 * right/bottom, and the % + translate(-50%) centering channel. Null = no
 * compensation applies (no rotation/skew, or the box is unknowable).
 */
export function sizeInputWrite(a: SizeInputWriteArgs): Record<string, string> | null {
  // No rotation AND no zero crossing → the plain size write is exact.
  if (!needsSizeCompensation(a.matrixStr) && a.newValue >= 0) return null;
  const box = sourceLayoutBox(a.styles, a.parentWidth, a.parentHeight, a.fallbackBox);
  if (!box) return null;
  const { left, top, width: newWidth, height: newHeight } = compensatedSizeInput(
    box, a.axis === 'width' ? a.newValue : box.width, a.axis === 'height' ? a.newValue : box.height, a.matrixStr,
  );
  // The painted box includes the translate; CSS left/top exclude it (at the NEW size).
  const cssLeft = left - translateOffsetPx(a.styles.transform, 'x', newWidth);
  const cssTop = top - translateOffsetPx(a.styles.transform, 'y', newHeight);
  const r2 = (n: number) => `${Math.round(n * 100) / 100}px`;
  const pct = (n: number, total: number) => `${((n / total) * 100).toFixed(4)}%`;
  const out: Record<string, string> = {};
  // A crossed size is written as its magnitude (CSS has no negative size).
  const wv = a.writeValue ?? r2(a.newValue);
  out[a.axis] = a.newValue < 0 ? wv.replace(/^-/, '') : wv;
  const s = a.styles;
  if (isPx(s.left)) out.left = r2(cssLeft);
  else if (isPct(s.left) && a.parentWidth > 0) out.left = pct(cssLeft, a.parentWidth);
  else if (isPx(s.right)) out.right = r2(a.parentWidth - cssLeft - newWidth);
  else if (isPct(s.right) && a.parentWidth > 0) out.right = pct(a.parentWidth - cssLeft - newWidth, a.parentWidth);
  if (isPx(s.top)) out.top = r2(cssTop);
  else if (isPct(s.top) && a.parentHeight > 0) out.top = pct(cssTop, a.parentHeight);
  else if (isPx(s.bottom)) out.bottom = r2(a.parentHeight - cssTop - newHeight);
  else if (isPct(s.bottom) && a.parentHeight > 0) out.bottom = pct(a.parentHeight - cssTop - newHeight, a.parentHeight);
  return out;
}

