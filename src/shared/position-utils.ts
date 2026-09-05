// position-utils.ts — Centralized visual stability engine.
// Every style reconfiguration captures the visual rect BEFORE, computes equivalent
// styles for the new mode, applies them → element doesn't move.
// Used by: PinControl, PositionTypeControl, LayoutTool, and any future system
// that changes positioning configuration.

import { trace } from './debug-trace';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface VisualRect {
  /** Element position relative to parent, in CSS px */
  left: number;
  top: number;
  /** Element dimensions in CSS px (unaffected by transforms) */
  width: number;
  height: number;
  /** Parent dimensions in CSS px */
  parentWidth: number;
  parentHeight: number;
  /** Element center as percentage of parent */
  centerXPercent: number;
  centerYPercent: number;
}

// ─── Visual Rect Capture ────────────────────────────────────────────────────

// ─── Transform Helpers ──────────────────────────────────────────────────────

/** Strip ALL translate functions from a transform string. Keeps rotate/scale/skew. */
export function stripTranslateTransforms(transform: string | undefined): string {
  if (!transform || transform === 'none') return '';
  return transform
    .replace(/translate3d\([^)]+\)/gi, '')
    .replace(/translateX\([^)]+\)/gi, '')
    .replace(/translateY\([^)]+\)/gi, '')
    .replace(/translateZ\([^)]+\)/gi, '')
    .replace(/translate\([^)]+\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build a transform string with a translate part prepended to existing visual transforms. */
export function buildTransformWithTranslate(translatePart: string, existingTransform: string | undefined): string {
  const visual = stripTranslateTransforms(existingTransform);
  return visual ? `${translatePart} ${visual}` : translatePart;
}

/** Extract ONE axis's translate component from a transform string, normalized to
 *  a single-axis function (`translateX(...)` / `translateY(...)`). Handles both
 *  the single-axis forms AND the 2-arg `translate(x, y)` shorthand (y defaults to
 *  0 when omitted). Returns '' when that axis carries no (non-zero) translate.
 *
 *  Used to PRESERVE the untouched axis's centering when a pin toggle rewrites
 *  the transform for the OTHER axis — see `buildAxisCenterTransform`. */
export function extractAxisTranslate(transform: string | undefined, axis: 'x' | 'y'): string {
  if (!transform || transform === 'none') return '';
  const A = axis.toUpperCase();
  const isZero = (v: string) => v === '0' || v === '0px' || v === '0%';
  // Single-axis form wins: translateX(...) / translateY(...).
  const single = new RegExp(`translate${A}\\(\\s*([^)]+?)\\s*\\)`, 'i').exec(transform);
  if (single) {
    const v = single[1].trim();
    return v && !isZero(v) ? `translate${A}(${v})` : '';
  }
  // 2-arg shorthand: translate(x, y). `translate\(` can't match translateX/Y(
  // (no `(` immediately after `translate`), so this only catches the shorthand.
  const two = /translate\(\s*([^,)]+?)\s*(?:,\s*([^)]+?)\s*)?\)/i.exec(transform);
  if (two) {
    const v = (axis === 'x' ? two[1] : two[2])?.trim();
    if (v && !isZero(v)) return `translate${A}(${v})`;
  }
  return '';
}

/** Build the transform for converting ONE axis to percentage-center mode
 *  (`translate<Axis>(-50%)`) while PRESERVING the OTHER axis's existing translate
 *  and any rotate/scale/skew. `buildTransformWithTranslate` stripped ALL
 *  translates, which dropped the other axis's centering and shifted the element
 *  on that axis — unpinning a horizontally-and-vertically-centered element's
 *  left pin lost its `translateY(-50%)` and it jumped down by half its height
 *  (live find 2026-07-24, an icon dropped with `translate(-50%, -50%)`). */
export function buildAxisCenterTransform(axis: 'x' | 'y', existingTransform: string | undefined): string {
  const thisT = axis === 'x' ? 'translateX(-50%)' : 'translateY(-50%)';
  const otherT = extractAxisTranslate(existingTransform, axis === 'x' ? 'y' : 'x');
  const visuals = stripTranslateTransforms(existingTransform);
  return [thisT, otherT, visuals].filter(Boolean).join(' ');
}

/** Which channel carries an element's centering translate. A design-component
 *  (`motion.*`) element may pin through motion's INDEPENDENT props
 *  (`x: '-50%'`, `y: '-50%'`) instead of a CSS translate string — that is how
 *  the rotation commit / geometry migration store a pin. Every writer that
 *  sets a centering translate must use the SAME channel: the Renderer folds
 *  the string first, then the shorthands, so mixing them shifts the element
 *  twice (live find 2026-09-05: align on a shorthand-centred svg wrote
 *  `translateX(-50%)` beside `x: '-50%'` and it landed half a width left). */
export function centeringChannel(styles: Record<string, string | undefined>): 'shorthand' | 'string' {
  const set = (v: string | undefined) => v != null && v !== '' && v !== 'auto';
  return set(styles.x) || set(styles.y) ? 'shorthand' : 'string';
}

/** Remove ONE axis's translate from a transform string, keeping the OTHER
 *  axis's translate and every visual (rotate/scale/skew). A 2-arg
 *  `translate(x, y)` is split so the kept axis survives as `translateY(..)`.
 *  Returns '' when nothing is left (→ remove the property). */
export function removeAxisTranslate(transform: string | undefined, axis: 'x' | 'y'): string {
  if (!transform || transform === 'none') return '';
  const other = extractAxisTranslate(transform, axis === 'x' ? 'y' : 'x');
  const visuals = stripTranslateTransforms(transform);
  return [other, visuals].filter(Boolean).join(' ');
}

// ─── Position Mode Conversions ──────────────────────────────────────────────

/**
 * Convert to percentage centering mode (no pins active).
 * Element gets left/top as percentages + translate(-50%, -50%) for centering.
 */
export function toPercentageCenter(
  rect: VisualRect,
  existingTransform?: string,
): Record<string, string> {
  return {
    left: `${rect.centerXPercent.toFixed(4)}%`,
    top: `${rect.centerYPercent.toFixed(4)}%`,
    right: '',
    bottom: '',
    width: `${Math.round(rect.width)}px`,
    height: `${Math.round(rect.height)}px`,
    transform: buildTransformWithTranslate('translate(-50%, -50%)', existingTransform),
  };
}

/**
 * Pin a single side to a fixed px value.
 */
export function toFixedPin(
  side: 'left' | 'right' | 'top' | 'bottom',
  rect: VisualRect,
): Record<string, string> {
  switch (side) {
    case 'left': return { left: `${Math.round(rect.left)}px` };
    case 'right': return { right: `${Math.round(rect.parentWidth - rect.left - rect.width)}px` };
    case 'top': return { top: `${Math.round(rect.top)}px` };
    case 'bottom': return { bottom: `${Math.round(rect.parentHeight - rect.top - rect.height)}px` };
  }
}

/**
 * Enter inset mode on an axis (both sides pinned, dimension removed).
 * Element stretches between the two pinned values.
 */
export function toInsetMode(
  axis: 'horizontal' | 'vertical',
  rect: VisualRect,
): Record<string, string> {
  if (axis === 'horizontal') {
    return {
      left: `${Math.round(rect.left)}px`,
      right: `${Math.round(rect.parentWidth - rect.left - rect.width)}px`,
      width: '',
    };
  }
  return {
    top: `${Math.round(rect.top)}px`,
    bottom: `${Math.round(rect.parentHeight - rect.top - rect.height)}px`,
    height: '',
  };
}

/**
 * Exit inset mode on an axis (unpin one side, restore dimension from DOM).
 */
export function fromInsetMode(
  removedSide: 'left' | 'right' | 'top' | 'bottom',
  rect: VisualRect,
): Record<string, string> {
  const isHoriz = removedSide === 'left' || removedSide === 'right';
  return {
    [removedSide]: '',
    [isHoriz ? 'width' : 'height']: `${Math.round(rect[isHoriz ? 'width' : 'height'])}px`,
  };
}

/**
 * Convert to relative positioning. Clears all position properties.
 */
export function toRelative(existingTransform?: string): Record<string, string> {
  return {
    position: 'relative',
    left: '',
    top: '',
    right: '',
    bottom: '',
    transform: stripTranslateTransforms(existingTransform) || '',
  };
}

/**
 * Convert to absolute positioning, preserving visual position.
 */
export function toAbsolute(rect: VisualRect): Record<string, string> {
  return {
    position: 'absolute',
    left: `${Math.round(rect.left)}px`,
    top: `${Math.round(rect.top)}px`,
  };
}

// ─── Dimension Resolution ────────────────────────────────────────────────────

/**
 * Resolve any CSS dimension value to its computed px value.
 * Handles: auto, %, px, vw, vh, fit-content, min-content, max-content,
 * flex shorthand (flex: 1 0 0px), and any other value the browser computes.
 *
 * @param cssValue - The CSS value string (e.g. 'auto', '50%', '200px', 'fit-content')
 * @param computedPx - The actual rendered size from the DOM (offsetWidth/offsetHeight)
 * @param parentPx - Parent's content dimension for percentage resolution
 * @returns The resolved px value as a number
 */
function resolveComputedPx(
  cssValue: string | undefined,
  computedPx: number,
  _parentPx?: number,
): number {
  if (!cssValue || cssValue === 'auto' || cssValue === 'none') return computedPx;

  // Fixed px — parse directly
  if (cssValue.endsWith('px')) {
    const v = parseFloat(cssValue);
    return isNaN(v) ? computedPx : v;
  }

  // Percentage — resolve against parent
  if (cssValue.endsWith('%') && _parentPx) {
    const v = parseFloat(cssValue);
    return isNaN(v) ? computedPx : (v / 100) * _parentPx;
  }

  // vw/vh
  if (cssValue.endsWith('vw')) {
    const v = parseFloat(cssValue);
    return isNaN(v) ? computedPx : (v / 100) * window.innerWidth;
  }
  if (cssValue.endsWith('vh')) {
    const v = parseFloat(cssValue);
    return isNaN(v) ? computedPx : (v / 100) * window.innerHeight;
  }

  // Everything else (fit-content, min-content, max-content, flex-basis, calc, etc.)
  // → use the actual computed value from the DOM
  return computedPx;
}

/**
 * Resolve an element's width and height CSS values to px.
 * Reads the current inline style + DOM computed size.
 * Also clears flex shorthand that would override explicit width/height.
 *
 * Returns a styles object with width, height in px, plus any flex props to clear.
 */
function resolveDimensionsToPx(el: HTMLElement): Record<string, string> {
  const widthVal = el.style.width;
  const heightVal = el.style.height;
  const parentEl = el.parentElement;
  const parentW = parentEl ? parentEl.clientWidth : 0;
  const parentH = parentEl ? parentEl.clientHeight : 0;
  const computedW = el.offsetWidth;
  const computedH = el.offsetHeight;

  const styles: Record<string, string> = {};

  // Resolve width — only if explicitly set to a non-px value (%, vw, fit-content, etc.)
  // If empty/auto (not set), leave it alone — auto is the correct default
  if (widthVal && widthVal !== 'auto' && !widthVal.endsWith('px')) {
    styles.width = `${Math.round(resolveComputedPx(widthVal, computedW, parentW))}px`;
  }

  // Resolve height — same logic
  if (heightVal && heightVal !== 'auto' && !heightVal.endsWith('px')) {
    styles.height = `${Math.round(resolveComputedPx(heightVal, computedH, parentH))}px`;
  }

  // Clear flex shorthand that would override explicit width/height
  if (el.style.flex) styles.flex = '';
  if (el.style.flexGrow) styles.flexGrow = '';
  if (el.style.flexShrink) styles.flexShrink = '';
  if (el.style.flexBasis) styles.flexBasis = '';
  if (el.style.alignSelf) styles.alignSelf = '';

  return styles;
}

// ─── Layout Change Helpers ──────────────────────────────────────────────────

/**
 * Convert a child from absolute to relative (when parent gains layout).
 * Clears all positioning props, keeps width/height, strips translate transforms.
 */
export function convertChildToRelative(childEl: HTMLElement): Record<string, string> {
  const transform = stripTranslateTransforms(childEl.style.transform);

  // Resolve any non-px dimensions (auto, %, flex, fit-content, etc.) to px
  const resolved = resolveDimensionsToPx(childEl);

  const styles: Record<string, string> = {
    position: 'relative',
    left: '',
    top: '',
    right: '',
    bottom: '',
    transform: transform || '',
    ...resolved,
  };

  trace.action('position-utils:to-relative', { width: styles.width, height: styles.height });
  return styles;
}

/**
 * Convert a child from relative to absolute (when parent loses layout).
 * Captures visual position from DOM via getBoundingClientRect before layout changes.
 */
export function convertChildToAbsolute(
  childEl: HTMLElement,
  parentEl: HTMLElement,
  scale: number,
): Record<string, string> {
  const childRect = childEl.getBoundingClientRect();
  const parentRect = parentEl.getBoundingClientRect();

  const left = (childRect.left - parentRect.left) / scale;
  const top = (childRect.top - parentRect.top) / scale;

  // Resolve any non-px dimensions and clear flex shorthand
  const resolved = resolveDimensionsToPx(childEl);

  const styles: Record<string, string> = {
    position: 'absolute',
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    ...resolved,
  };

  // Only inject width/height if the child had them explicitly set
  const widthVal = childEl.style.width;
  const heightVal = childEl.style.height;
  if (widthVal && widthVal !== 'auto') {
    styles.width = widthVal.endsWith('px') ? widthVal : `${Math.round(childRect.width / scale)}px`;
  }
  if (heightVal && heightVal !== 'auto') {
    styles.height = heightVal.endsWith('px') ? heightVal : `${Math.round(childRect.height / scale)}px`;
  }

  trace.action('position-utils:to-absolute', { left: styles.left, top: styles.top });
  return styles;
}

// ─── Replica clear semantics ────────────────────────────────────────────────

/** Props whose replica-channel neutral is `auto`. */
const AUTO_NEUTRAL_PROPS = new Set(['left', 'top', 'right', 'bottom', 'width', 'height']);

/**
 * Translate `'' = delete` clears into explicit NEUTRAL overrides for a
 * replica-channel write.
 *
 * On the primary, `''` removes the inline property — done. On a non-primary
 * viewport (page @container band) or component variant (variants object),
 * `''` only deletes THIS channel's override key and the BASE value cascades
 * straight back: unpinning right/bottom on a variant left them pinned because
 * the master's `right: 40px / bottom: -69px` showed through the deleted keys
 * (user report 2026-08-26 — same law as the layout-injection replica
 * neutralization, 2026-08-05: "clear" and "neutralize" are different
 * operations on a replica).
 *
 * Only BASE-CARRIED props are translated (a prop the base doesn't state has
 * nothing to cascade — plain deletion is correct and keeps the band/entry
 * free of noise):
 *   left/top/right/bottom/width/height → 'auto'  (the CSS initial)
 *   position                           → 'static'
 *   transform                          → 'translate(0px, 0px)'
 *
 * transform is NOT 'none': the variants-object generator collapses a 'none'
 * write to a key delete (deliberately — a 'none' string would clobber
 * motion's composed transform), so 'none' silently becomes the very leak
 * this exists to fix. A pure-translate identity string takes the generator's
 * pure-translate gate, lands in the entry as-is, and overrides the base
 * string in the resolve merge — and in a @container band it's an equally
 * valid neutral.
 *
 * Pure: caller decides WHEN (non-primary, not solo-redirected) and supplies
 * the base styles.
 */
export function neutralizeReplicaClears(
  styles: Record<string, string>,
  baseStyles: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...styles };
  for (const [key, value] of Object.entries(styles)) {
    if (value !== '') continue;
    if (!baseStyles[key]) continue;
    if (AUTO_NEUTRAL_PROPS.has(key)) out[key] = 'auto';
    else if (key === 'position') out[key] = 'static';
    else if (key === 'transform') out[key] = 'translate(0px, 0px)';
  }
  return out;
}
