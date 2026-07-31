// crop-utils.ts — pure geometry for the image-crop modal. No DOM: the
// canvas rasterisation lives in `crop-image.ts` (browser-only). Kept pure so
// the handle math is unit-testable.
//
// A CropRect is always expressed in the SAME space as whatever it's paired
// with — the modal works in DISPLAY space (the on-screen fitted image) while
// dragging, then converts once to NATURAL space (source pixels) on Apply.

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** The 8 resize handles (corners + edge midpoints) + the interior move zone. */
export type CropHandle =
  | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';

const MIN_CROP = 8; // px, in display space — never let the crop collapse

/** Clamp a crop rect so it stays fully within [0,0]–bounds and keeps a
 *  minimum size. Order matters: size is clamped to bounds first, then the
 *  origin is pushed back in so the far edge doesn't spill over. */
export function clampCropRect(crop: CropRect, bounds: Size): CropRect {
  const width = Math.max(MIN_CROP, Math.min(crop.width, bounds.width));
  const height = Math.max(MIN_CROP, Math.min(crop.height, bounds.height));
  const x = Math.max(0, Math.min(crop.x, bounds.width - width));
  const y = Math.max(0, Math.min(crop.y, bounds.height - height));
  return { x, y, width, height };
}

/** Full crop = the whole image (the modal's initial + reset state). */
export function fullCrop(bounds: Size): CropRect {
  return { x: 0, y: 0, width: bounds.width, height: bounds.height };
}

/**
 * Apply a pointer delta to a crop rect for the given handle, then clamp.
 *   - 'move' translates the whole rect.
 *   - corner/edge handles move that edge (or two edges for a corner). The
 *     OPPOSITE edge stays pinned. A drag past the opposite edge is prevented
 *     by the MIN_CROP clamp (the edge stops rather than flipping).
 * `dx`/`dy` are in the SAME space as `crop` and `bounds` (display px).
 */
export function resizeCrop(
  crop: CropRect,
  handle: CropHandle,
  dx: number,
  dy: number,
  bounds: Size,
): CropRect {
  if (handle === 'move') {
    return clampCropRect({ ...crop, x: crop.x + dx, y: crop.y + dy }, bounds);
  }

  let { x, y, width, height } = crop;
  const right = x + width;
  const bottom = y + height;

  // West edge (nw, w, sw): move left edge, keep right pinned.
  if (handle === 'nw' || handle === 'w' || handle === 'sw') {
    const newX = Math.max(0, Math.min(x + dx, right - MIN_CROP));
    width = right - newX;
    x = newX;
  }
  // East edge (ne, e, se): move right edge, keep left pinned.
  if (handle === 'ne' || handle === 'e' || handle === 'se') {
    const newRight = Math.min(bounds.width, Math.max(right + dx, x + MIN_CROP));
    width = newRight - x;
  }
  // North edge (nw, n, ne): move top edge, keep bottom pinned.
  if (handle === 'nw' || handle === 'n' || handle === 'ne') {
    const newY = Math.max(0, Math.min(y + dy, bottom - MIN_CROP));
    height = bottom - newY;
    y = newY;
  }
  // South edge (sw, s, se): move bottom edge, keep top pinned.
  if (handle === 'sw' || handle === 's' || handle === 'se') {
    const newBottom = Math.min(bounds.height, Math.max(bottom + dy, y + MIN_CROP));
    height = newBottom - y;
  }

  return clampCropRect({ x, y, width, height }, bounds);
}

/**
 * Convert a crop rect from DISPLAY space (the fitted on-screen image) to
 * NATURAL space (source-image pixels), rounding to whole pixels. `display`
 * and `natural` are the two sizes of the same image; the rect scales by their
 * ratio. Result is clamped inside the natural bounds.
 */
export function displayToNaturalCrop(
  crop: CropRect,
  display: Size,
  natural: Size,
): CropRect {
  if (display.width <= 0 || display.height <= 0) return { x: 0, y: 0, width: natural.width, height: natural.height };
  const sx = natural.width / display.width;
  const sy = natural.height / display.height;
  const raw: CropRect = {
    x: Math.round(crop.x * sx),
    y: Math.round(crop.y * sy),
    width: Math.round(crop.width * sx),
    height: Math.round(crop.height * sy),
  };
  return clampCropRect(raw, natural);
}

/** True when the crop covers (essentially) the whole image — used to short-
 *  circuit Apply into a no-op so an untouched crop doesn't re-upload. */
export function isFullCrop(crop: CropRect, bounds: Size, tol = 0.5): boolean {
  return (
    crop.x <= tol &&
    crop.y <= tol &&
    crop.width >= bounds.width - tol &&
    crop.height >= bounds.height - tol
  );
}
