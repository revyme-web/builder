// pin-utils.ts — Pure functions for pin control logic.
// No DOM, no React, no side effects — fully testable.

export interface PinState {
  left: boolean;
  top: boolean;
  right: boolean;
  bottom: boolean;
}

export type InsetMode = 'none' | 'horizontal' | 'vertical' | 'full';
export type PinSide = 'left' | 'top' | 'right' | 'bottom';
export type AlignDirection = 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom';

/** Check if a CSS value is a fixed pixel value (not calc, %, auto, undefined) */
export function isFixedPx(value: string | undefined): boolean {
  if (!value) return false;
  return /^-?[\d.]+px$/.test(value);
}

/** Parse a CSS px value to number. Returns 0 if not parseable. */
export function parsePx(value: string | undefined): number {
  if (!value) return 0;
  const num = parseFloat(value);
  return isNaN(num) ? 0 : num;
}

/** Get pin state from node styles. A pin is active when it has a fixed px value. */
export function getPinState(styles: Record<string, string>): PinState {
  return {
    left: isFixedPx(styles.left),
    top: isFixedPx(styles.top),
    right: isFixedPx(styles.right),
    bottom: isFixedPx(styles.bottom),
  };
}

/** Detect inset mode based on which opposite pins are active */
export function getInsetMode(pins: PinState): InsetMode {
  const h = pins.left && pins.right;
  const v = pins.top && pins.bottom;
  if (h && v) return 'full';
  if (h) return 'horizontal';
  if (v) return 'vertical';
  return 'none';
}

/** Get the opposite side */
export function oppositeSide(side: PinSide): PinSide {
  switch (side) {
    case 'left': return 'right';
    case 'right': return 'left';
    case 'top': return 'bottom';
    case 'bottom': return 'top';
  }
}

/** Is this side horizontal (left/right) or vertical (top/bottom)? */
export function isHorizontal(side: PinSide): boolean {
  return side === 'left' || side === 'right';
}

/**
 * Toggle a pin side. Returns the styles to apply.
 *
 * When pinning both sides of an axis:
 *   - Remove width/height (element stretches via inset)
 *   - Calculate the opposite side value from element + parent rects
 *
 * When unpinning one side of a pair:
 *   - Restore width/height from current element dimensions
 *   - Remove the unpinned side's CSS property
 */
export function togglePin(
  side: PinSide,
  currentStyles: Record<string, string>,
  elementRect: { width: number; height: number; left: number; top: number },
  parentRect: { width: number; height: number },
): Record<string, string> {
  const pins = getPinState(currentStyles);
  const wasPinned = pins[side];
  const opp = oppositeSide(side);
  const oppPinned = pins[opp];
  const horiz = isHorizontal(side);
  const sizeKey = horiz ? 'width' : 'height';
  const newStyles: Record<string, string> = {};

  if (wasPinned) {
    // ─── UNPINNING ─────────────────────────────────────────────────
    // Remove this side's value
    newStyles[side] = '';

    // If opposite was also pinned (inset mode), restore dimension
    if (oppPinned) {
      // Restore width/height from current element size
      newStyles[sizeKey] = `${Math.round(elementRect[horiz ? 'width' : 'height'])}px`;
    }
  } else {
    // ─── PINNING ───────────────────────────────────────────────────
    if (oppPinned) {
      // Both sides now pinned → enter inset mode
      // Calculate this side's value: parent size - element far edge
      const elemSize = elementRect[horiz ? 'width' : 'height'];
      const elemPos = elementRect[horiz ? 'left' : 'top'];
      const parentSize = parentRect[horiz ? 'width' : 'height'];

      if (side === 'right' || side === 'bottom') {
        // right = parentWidth - (left + width)
        newStyles[side] = `${Math.round(parentSize - elemPos - elemSize)}px`;
      } else {
        // left = elemPos (already set, but ensure it's correct)
        newStyles[side] = `${Math.round(elemPos)}px`;
      }

      // Remove width/height — element stretches via inset
      newStyles[sizeKey] = '';
    } else {
      // Single pin — just set the value
      const elemPos = elementRect[horiz ? 'left' : 'top'];
      const elemSize = elementRect[horiz ? 'width' : 'height'];
      const parentSize = parentRect[horiz ? 'width' : 'height'];

      if (side === 'right') {
        newStyles[side] = `${Math.round(parentSize - elemPos - elemSize)}px`;
      } else if (side === 'bottom') {
        newStyles[side] = `${Math.round(parentSize - elemPos - elemSize)}px`;
      } else {
        newStyles[side] = `${Math.round(elemPos)}px`;
      }
    }
  }

  return newStyles;
}

// ─── Transform helpers (translateX/Y extraction + rebuild) ──────────────────
// Ported from the old builder's `alignment-operations.ts`. The aligner uses
// `translateX(-50%)` / `translateY(-50%)` for percentage-based centring, so it
// has to edit the translate part of `transform` while preserving any visual
// transforms (rotate / scale / skew). An empty return means "no transform".

function extractTranslateX(transform: string): string | null {
  const m = transform.match(/translate\(\s*([^,)]+)/i);
  if (m) return m[1].trim();
  const mx = transform.match(/translateX\(\s*([^)]+)\s*\)/i);
  return mx ? mx[1].trim() : null;
}

function extractTranslateY(transform: string): string | null {
  const m = transform.match(/translate\(\s*[^,]+,\s*([^)]+)\s*\)/i);
  if (m) return m[1].trim();
  const my = transform.match(/translateY\(\s*([^)]+)\s*\)/i);
  return my ? my[1].trim() : null;
}

/** Rebuild `transform` with a new translateX, keeping translateY + visual
 *  transforms. Returns '' when nothing is left (→ remove the property). */
function buildTransformWithNewX(existingTransform: string, newTranslateX: string | null): string {
  const translateY = extractTranslateY(existingTransform);
  const visual = existingTransform.replace(/translate[XYZ3d]*\([^)]+\)/gi, '').trim();
  const parts: string[] = [];
  if (newTranslateX) parts.push(`translateX(${newTranslateX})`);
  if (translateY) parts.push(`translateY(${translateY})`);
  if (visual) parts.push(visual);
  return parts.join(' ');
}

/** Rebuild `transform` with a new translateY, keeping translateX + visual
 *  transforms. Returns '' when nothing is left (→ remove the property). */
function buildTransformWithNewY(existingTransform: string, newTranslateY: string | null): string {
  const translateX = extractTranslateX(existingTransform);
  const visual = existingTransform.replace(/translate[XYZ3d]*\([^)]+\)/gi, '').trim();
  const parts: string[] = [];
  if (translateX) parts.push(`translateX(${translateX})`);
  if (newTranslateY) parts.push(`translateY(${newTranslateY})`);
  if (visual) parts.push(visual);
  return parts.join(' ');
}

/**
 * Calculate the styles to apply for an alignment action.
 *
 * Ported from the old builder's `alignment-operations.ts`. The previous
 * "set left = parentW - elemW" version broke every non-trivial case — a
 * right-pinned element, a `%`-positioned element, an element inset with
 * both sides pinned. This version inspects the node's CURRENT pin config
 * and writes the correct combination:
 *
 *  - Pinned px on one side → snap that side, clear the opposite.
 *  - Inset (both sides of an axis pinned px) → adjust both inset values
 *    (restoring an explicit width/height when only the cross-axis is free)
 *    so the element keeps stretching correctly.
 *  - Unpinned / `%`-positioned → centre-point system: a `%` left/top plus
 *    `translateX(-50%)` / `translateY(-50%)`, so alignment stays correct
 *    when the parent or element later resizes.
 *
 * `''` values mean "remove this property" (the builder's empty-string =
 * delete convention — the old builder used `undefined` for the same thing).
 */
export function calculateAlignment(
  direction: AlignDirection,
  styles: Record<string, string>,
  elementRect: { width: number; height: number },
  parentRect: { width: number; height: number },
): Record<string, string> {
  const leftPinned = isFixedPx(styles.left);
  const rightPinned = isFixedPx(styles.right);
  const topPinned = isFixedPx(styles.top);
  const bottomPinned = isFixedPx(styles.bottom);

  const parentWidth = parentRect.width;
  const parentHeight = parentRect.height;

  const isHorizontalInset = leftPinned && rightPinned;
  const isVerticalInset = topPinned && bottomPinned;
  const isFullInsetMode = isHorizontalInset && isVerticalInset;

  const isSet = (v: string | undefined) => v != null && v !== '' && v !== 'auto';
  const hasTop = isSet(styles.top);
  const hasBottom = isSet(styles.bottom);
  const hasLeft = isSet(styles.left);
  const hasRight = isSet(styles.right);

  const existingTransform = styles.transform || '';
  // The element's bounding rect already bakes in any rotate/scale/skew, so
  // when a visual transform is present prefer the explicit width/height.
  const hasVisualTransform = /rotate|scale|skew/i.test(existingTransform);

  let visualWidth: number;
  if (isHorizontalInset) {
    visualWidth = parentWidth - (parseFloat(styles.left) || 0) - (parseFloat(styles.right) || 0);
  } else if (hasVisualTransform && styles.width) {
    visualWidth = parseFloat(styles.width) || 0;
  } else {
    visualWidth = elementRect.width;
  }

  let visualHeight: number;
  if (isVerticalInset) {
    visualHeight = parentHeight - (parseFloat(styles.top) || 0) - (parseFloat(styles.bottom) || 0);
  } else if (hasVisualTransform && styles.height) {
    visualHeight = parseFloat(styles.height) || 0;
  } else {
    visualHeight = elementRect.height;
  }

  const u: Record<string, string> = {};

  switch (direction) {
    case 'left':
      if (isFullInsetMode || (isHorizontalInset && (hasTop || hasBottom))) {
        u.left = '0px';
        u.right = `${parentWidth - visualWidth}px`;
        if (!isFullInsetMode) u.width = '';
      } else if (isHorizontalInset) {
        u.width = `${visualWidth}px`;
        u.left = '0px';
        u.right = `${parentWidth - visualWidth}px`;
      } else if (isVerticalInset && rightPinned) {
        u.right = `${parentWidth - visualWidth}px`;
        u.left = '';
        u.transform = buildTransformWithNewX(existingTransform, null);
      } else if (isVerticalInset && leftPinned) {
        u.left = '0px';
        u.right = '';
        u.transform = buildTransformWithNewX(existingTransform, null);
      } else if (isVerticalInset) {
        u.left = `${((visualWidth / 2 / parentWidth) * 100).toFixed(4)}%`;
        u.right = '';
        u.transform = buildTransformWithNewX(existingTransform, '-50%');
      } else if (leftPinned) {
        u.left = '0px';
      } else if (rightPinned) {
        u.right = `${parentWidth - visualWidth}px`;
      } else {
        u.left = `${((visualWidth / 2 / parentWidth) * 100).toFixed(4)}%`;
        u.right = '';
        u.transform = buildTransformWithNewX(existingTransform, '-50%');
      }
      break;

    case 'center-h':
      if (isFullInsetMode || (isHorizontalInset && (hasTop || hasBottom))) {
        const inset = (parentWidth - visualWidth) / 2;
        u.left = `${inset}px`;
        u.right = `${inset}px`;
        if (!isFullInsetMode) u.width = '';
      } else if (isHorizontalInset) {
        u.width = `${visualWidth}px`;
        const inset = (parentWidth - visualWidth) / 2;
        u.left = `${inset}px`;
        u.right = `${inset}px`;
      } else if (isVerticalInset && leftPinned) {
        u.left = `${(parentWidth - visualWidth) / 2}px`;
        u.transform = buildTransformWithNewX(existingTransform, null);
      } else if (isVerticalInset && rightPinned) {
        u.right = `${(parentWidth - visualWidth) / 2}px`;
        u.transform = buildTransformWithNewX(existingTransform, null);
      } else if (isVerticalInset) {
        u.left = '50%';
        u.transform = buildTransformWithNewX(existingTransform, '-50%');
      } else if (leftPinned) {
        u.left = `${(parentWidth - visualWidth) / 2}px`;
      } else if (rightPinned) {
        u.right = `${(parentWidth - visualWidth) / 2}px`;
      } else {
        u.left = '50%';
        u.right = '';
        u.transform = buildTransformWithNewX(existingTransform, '-50%');
      }
      break;

    case 'right':
      if (isFullInsetMode || (isHorizontalInset && (hasTop || hasBottom))) {
        u.right = '0px';
        u.left = `${parentWidth - visualWidth}px`;
        if (!isFullInsetMode) u.width = '';
      } else if (isHorizontalInset) {
        u.width = `${visualWidth}px`;
        u.right = '0px';
        u.left = `${parentWidth - visualWidth}px`;
      } else if (isVerticalInset && leftPinned) {
        u.left = `${parentWidth - visualWidth}px`;
        u.right = '';
        u.transform = buildTransformWithNewX(existingTransform, null);
      } else if (isVerticalInset && rightPinned) {
        u.right = '0px';
        u.left = '';
        u.transform = buildTransformWithNewX(existingTransform, null);
      } else if (isVerticalInset) {
        u.left = `${(((parentWidth - visualWidth / 2) / parentWidth) * 100).toFixed(4)}%`;
        u.right = '';
        u.transform = buildTransformWithNewX(existingTransform, '-50%');
      } else if (rightPinned) {
        u.right = '0px';
      } else if (leftPinned) {
        u.left = `${parentWidth - visualWidth}px`;
      } else {
        u.left = `${(((parentWidth - visualWidth / 2) / parentWidth) * 100).toFixed(4)}%`;
        u.right = '';
        u.transform = buildTransformWithNewX(existingTransform, '-50%');
      }
      break;

    case 'top':
      if (isFullInsetMode || (isVerticalInset && (hasLeft || hasRight))) {
        u.top = '0px';
        u.bottom = `${parentHeight - visualHeight}px`;
        if (!isFullInsetMode) u.height = '';
      } else if (isVerticalInset) {
        u.height = `${visualHeight}px`;
        u.top = '0px';
        u.bottom = `${parentHeight - visualHeight}px`;
      } else if (isHorizontalInset && bottomPinned) {
        u.bottom = `${parentHeight - visualHeight}px`;
        u.top = '';
        u.transform = buildTransformWithNewY(existingTransform, null);
      } else if (isHorizontalInset && topPinned) {
        u.top = '0px';
        u.bottom = '';
        u.transform = buildTransformWithNewY(existingTransform, null);
      } else if (isHorizontalInset) {
        u.top = `${((visualHeight / 2 / parentHeight) * 100).toFixed(4)}%`;
        u.bottom = '';
        u.transform = buildTransformWithNewY(existingTransform, '-50%');
      } else if (topPinned) {
        u.top = '0px';
      } else if (bottomPinned) {
        u.bottom = `${parentHeight - visualHeight}px`;
      } else {
        u.top = `${((visualHeight / 2 / parentHeight) * 100).toFixed(4)}%`;
        u.bottom = '';
        u.transform = buildTransformWithNewY(existingTransform, '-50%');
      }
      break;

    case 'center-v':
      if (isFullInsetMode || (isVerticalInset && (hasLeft || hasRight))) {
        const inset = (parentHeight - visualHeight) / 2;
        u.top = `${inset}px`;
        u.bottom = `${inset}px`;
        if (!isFullInsetMode) u.height = '';
      } else if (isVerticalInset) {
        u.height = `${visualHeight}px`;
        const inset = (parentHeight - visualHeight) / 2;
        u.top = `${inset}px`;
        u.bottom = `${inset}px`;
      } else if (isHorizontalInset && topPinned) {
        u.top = `${(parentHeight - visualHeight) / 2}px`;
        u.transform = buildTransformWithNewY(existingTransform, null);
      } else if (isHorizontalInset && bottomPinned) {
        u.bottom = `${(parentHeight - visualHeight) / 2}px`;
        u.transform = buildTransformWithNewY(existingTransform, null);
      } else if (isHorizontalInset) {
        u.top = '50%';
        u.transform = buildTransformWithNewY(existingTransform, '-50%');
      } else if (topPinned) {
        u.top = `${(parentHeight - visualHeight) / 2}px`;
      } else if (bottomPinned) {
        u.bottom = `${(parentHeight - visualHeight) / 2}px`;
      } else {
        u.top = '50%';
        u.bottom = '';
        u.transform = buildTransformWithNewY(existingTransform, '-50%');
      }
      break;

    case 'bottom':
      if (isFullInsetMode || (isVerticalInset && (hasLeft || hasRight))) {
        u.bottom = '0px';
        u.top = `${parentHeight - visualHeight}px`;
        if (!isFullInsetMode) u.height = '';
      } else if (isVerticalInset) {
        u.height = `${visualHeight}px`;
        u.bottom = '0px';
        u.top = `${parentHeight - visualHeight}px`;
      } else if (isHorizontalInset && topPinned) {
        u.top = `${parentHeight - visualHeight}px`;
        u.bottom = '';
        u.transform = buildTransformWithNewY(existingTransform, null);
      } else if (isHorizontalInset && bottomPinned) {
        u.bottom = '0px';
        u.top = '';
        u.transform = buildTransformWithNewY(existingTransform, null);
      } else if (isHorizontalInset) {
        u.top = `${(((parentHeight - visualHeight / 2) / parentHeight) * 100).toFixed(4)}%`;
        u.bottom = '';
        u.transform = buildTransformWithNewY(existingTransform, '-50%');
      } else if (bottomPinned) {
        u.bottom = '0px';
      } else if (topPinned) {
        u.top = `${parentHeight - visualHeight}px`;
      } else {
        u.top = `${(((parentHeight - visualHeight / 2) / parentHeight) * 100).toFixed(4)}%`;
        u.bottom = '';
        u.transform = buildTransformWithNewY(existingTransform, '-50%');
      }
      break;
  }

  return u;
}

// ─── Inset Engine (centralized — used by resize, drag, dimensions) ──────

export interface InsetState {
  pins: PinState;
  mode: InsetMode;
  /** L+R pinned with no width property */
  horizontalInset: boolean;
  /** T+B pinned with no height property */
  verticalInset: boolean;
  /** All 4 pinned, no width, no height */
  fullInset: boolean;
}

/** Get full inset state from styles. Checks pins AND whether width/height exist. */
export function getInsetState(styles: Record<string, string>): InsetState {
  const pins = getPinState(styles);
  const hasWidth = !!styles.width && styles.width !== '' && styles.width !== 'auto';
  const hasHeight = !!styles.height && styles.height !== '' && styles.height !== 'auto';

  const horizontalInset = pins.left && pins.right && !hasWidth;
  const verticalInset = pins.top && pins.bottom && !hasHeight;
  const fullInset = horizontalInset && verticalInset;
  const mode = getInsetMode(pins);

  return { pins, mode, horizontalInset, verticalInset, fullInset };
}

/**
 * For RESIZE: Given the new element rect after resize, compute which CSS properties to set.
 * In inset mode, updates inset values instead of width/height.
 */
export function computeResizeInsetStyles(
  inset: InsetState,
  newRect: { left: number; top: number; width: number; height: number },
  parentRect: { width: number; height: number },
  isInLayout: boolean,
): Record<string, string> {
  const s: Record<string, string> = {};

  if (isInLayout) {
    // Layout children: only width/height, no position changes
    s.width = `${Math.round(newRect.width)}px`;
    s.height = `${Math.round(newRect.height)}px`;
    return s;
  }

  if (inset.horizontalInset) {
    s.left = `${Math.round(newRect.left)}px`;
    s.right = `${Math.round(parentRect.width - newRect.left - newRect.width)}px`;
    // Do NOT set width
  } else {
    s.width = `${Math.round(newRect.width)}px`;
    if (!isInLayout) s.left = `${Math.round(newRect.left)}px`;
  }

  if (inset.verticalInset) {
    s.top = `${Math.round(newRect.top)}px`;
    s.bottom = `${Math.round(parentRect.height - newRect.top - newRect.height)}px`;
    // Do NOT set height
  } else {
    s.height = `${Math.round(newRect.height)}px`;
    if (!isInLayout) s.top = `${Math.round(newRect.top)}px`;
  }

  return s;
}

/**
 * For DRAG: Given a delta (dx, dy), compute which CSS properties to update.
 * In inset mode, moves ALL pinned sides so the element translates without changing size.
 */
export function computeDragInsetStyles(
  inset: InsetState,
  currentStyles: Record<string, string>,
  dx: number,
  dy: number,
): Record<string, string> {
  const s: Record<string, string> = {};

  // Horizontal axis
  if (inset.horizontalInset) {
    // Both L+R pinned: shift both by dx
    s.left = `${Math.round(parsePx(currentStyles.left) + dx)}px`;
    s.right = `${Math.round(parsePx(currentStyles.right) - dx)}px`;
  } else if (inset.pins.left) {
    s.left = `${Math.round(parsePx(currentStyles.left) + dx)}px`;
  } else if (inset.pins.right) {
    s.right = `${Math.round(parsePx(currentStyles.right) - dx)}px`;
  } else {
    s.left = `${Math.round(parsePx(currentStyles.left) + dx)}px`;
  }

  // Vertical axis
  if (inset.verticalInset) {
    // Both T+B pinned: shift both by dy
    s.top = `${Math.round(parsePx(currentStyles.top) + dy)}px`;
    s.bottom = `${Math.round(parsePx(currentStyles.bottom) - dy)}px`;
  } else if (inset.pins.top) {
    s.top = `${Math.round(parsePx(currentStyles.top) + dy)}px`;
  } else if (inset.pins.bottom) {
    s.bottom = `${Math.round(parsePx(currentStyles.bottom) - dy)}px`;
  } else {
    s.top = `${Math.round(parsePx(currentStyles.top) + dy)}px`;
  }

  return s;
}

/**
 * For DIMENSIONS: When user types a new width/height value.
 * In inset mode, updates the opposite inset instead of width/height.
 */
export function computeDimensionInsetStyles(
  inset: InsetState,
  currentStyles: Record<string, string>,
  axis: 'width' | 'height',
  newValue: number,
  parentSize: number,
): Record<string, string> {
  if (axis === 'width' && inset.horizontalInset) {
    // Keep left fixed, update right = parent - left - newWidth
    const left = parsePx(currentStyles.left);
    return {
      left: `${Math.round(left)}px`,
      right: `${Math.round(parentSize - left - newValue)}px`,
    };
  }

  if (axis === 'height' && inset.verticalInset) {
    // Keep top fixed, update bottom = parent - top - newHeight
    const top = parsePx(currentStyles.top);
    return {
      top: `${Math.round(top)}px`,
      bottom: `${Math.round(parentSize - top - newValue)}px`,
    };
  }

  // Not in inset mode — normal dimension update
  return { [axis]: `${Math.round(newValue)}px` };
}

/**
 * Calculate preserved position when switching position types.
 * Ensures the element doesn't visually jump.
 */
export function calculatePreservedPosition(
  fromType: string,
  toType: string,
  elementScreenRect: { left: number; top: number },
  parentScreenRect: { left: number; top: number },
): Record<string, string> {
  const styles: Record<string, string> = { position: toType };

  if (toType === 'absolute' || toType === 'fixed') {
    // Position relative to parent
    styles.left = `${Math.round(elementScreenRect.left - parentScreenRect.left)}px`;
    styles.top = `${Math.round(elementScreenRect.top - parentScreenRect.top)}px`;
  } else if (toType === 'relative') {
    styles.left = '';
    styles.top = '';
  } else if (toType === 'sticky') {
    styles.left = '';
    styles.top = '0px'; // stickyTop default
  }

  return styles;
}

// ─── Position-type availability gating (design-tool parity) ───────────────────────

export interface PositionTypeOption { value: string; label: string; disabled?: boolean }
export interface PositionTypeContext {
  /** Currently-applied position (never disabled, so it always renders selected). */
  position: string;
  /** Parent has a flow layout (flex/grid). Relative + Sticky require it. */
  parentHasLayout: boolean;
  /** The node is a DIRECT child of the viewport/page root. Fixed requires it. */
  isViewportChild: boolean;
}

/**
 * Mark each position-type option `disabled` based on context, matching design-tool rules:
 *   • absolute — always valid (free positioning in any parent).
 *   • relative / sticky — only when the parent has a layout (flex/grid); a free/no-layout parent
 *     has no flow to join, so the child can only be absolute.
 *   • fixed — only for a direct child of the viewport (positioned against the viewport).
 * The active `position` is never disabled (it must stay visible + selected).
 */
export function gatePositionTypeOptions(
  options: PositionTypeOption[],
  ctx: PositionTypeContext,
): PositionTypeOption[] {
  return options.map((opt) => {
    let disabled = false;
    if (opt.value === 'relative' || opt.value === 'sticky') disabled = !ctx.parentHasLayout;
    else if (opt.value === 'fixed') disabled = !ctx.isViewportChild;
    if (opt.value === ctx.position) disabled = false;
    return { ...opt, disabled };
  });
}
