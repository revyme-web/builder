// style-apply.ts — inline-style write helpers (CSS custom-property aware)
// + SVG Inside/Outside stroke-alignment application. Extracted verbatim from
// Renderer.ts (Phase 7 split).

import { coerceCssNumberToPx } from '@/shared/css-utils';
import { injectCanvasCSS, removeCanvasCSS } from '../node-ops';
import { isPreviewAppliedBg } from './canvas-image-preview';

/**
 * Apply Inside/Outside stroke alignment via a per-shape CSS rule (NOT
 * inline style). SVG natively strokes centered on the path edge (half
 * inside, half outside). We fake the other two modes:
 *   • Inside  — clip-path to the shape's own geometry, hiding the
 *               outer half of the centered stroke.
 *   • Outside — paint-order: stroke fill, so the fill paints over the
 *               inner half of the stroke, leaving only the outer half.
 *
 * Why a stylesheet rule instead of `el.style.clipPath = …`: setting
 * inline style is captured when shape-edit-host serializes the SVG
 * via `activeSvg.innerHTML` on commit, which then writes the inline
 * style back into source as `style="clip-path: path(…)"`. Stale styles
 * pile up on every align toggle, layering broken clips on top of each
 * other. Putting the rule in `<style data-canvas-styles>` keeps it
 * out of the shape's attribute string.
 *
 * Always also clears `el.style.clipPath` / `el.style.paintOrder` so
 * any leftover inline style from a prior (buggy) source state is wiped
 * from the live DOM on render. `!important` on the stylesheet rule is
 * not needed — inline cleared means CSS rule wins automatically.
 */
/** Find or create a `<defs>` as first child of `svg`. The renderer-injected
 *  defs gets `data-rev-defs` so shape-edit-host's commit serializer can strip
 *  it back out (along with our `clip-path` attrs) — otherwise the next
 *  shape-edit round-trip would bake the runtime clip artifacts into source. */
function ensureSvgDefs(svg: SVGSVGElement): SVGDefsElement {
  let defs = svg.querySelector(':scope > defs[data-rev-defs="1"]') as SVGDefsElement | null;
  if (!defs) {
    defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs') as unknown as SVGDefsElement;
    defs.setAttribute('data-rev-defs', '1');
    svg.insertBefore(defs, svg.firstChild);
  }
  return defs;
}

export function applyStrokeAlignment(el: Element, type: string, attrs: Record<string, string>, dataId: string): void {
  const align = attrs['data-stroke-align'];

  // Always wipe any inline style we (or a stale source attr) might have
  // set previously. CSS clip-path / paint-order on SVG content elements
  // is unreliable (Chrome interprets path() coords in border-box, not
  // user-space) — we use SVG-native <clipPath> defs for Inside and a
  // CSS rule only for Outside (paint-order has no SVG-attr equivalent).
  const style = (el as SVGElement & ElementCSSInlineStyle).style;
  if (style.clipPath)  style.clipPath = '';
  if (style.paintOrder) style.paintOrder = '';

  const cssSelector = `[data-id="${dataId}"]`;
  const clipId = `rev-stroke-clip-${dataId}`;
  const parentSvg = el.closest('svg') as SVGSVGElement | null;

  // Tear-down for non-inside states (also runs as the first step on
  // re-enter so a center→inside→outside flip can't leave stale defs).
  if (align !== 'inside' && parentSvg) {
    const existing = parentSvg.querySelector(`defs[data-rev-defs="1"] #${CSS.escape(clipId)}`);
    if (existing) existing.remove();
    if (el.getAttribute('clip-path') === `url(#${clipId})`) el.removeAttribute('clip-path');
    // Collapse the renderer-injected defs if it's now empty.
    const defs = parentSvg.querySelector(':scope > defs[data-rev-defs="1"]');
    if (defs && !defs.firstElementChild) defs.remove();
  }

  if (align === 'inside') {
    if (!parentSvg) { removeCanvasCSS(cssSelector); return; }
    // Build a <clipPath> whose contents match the shape's geometry, then
    // point the shape at it via `clip-path="url(#…)"`. The clipPath lives
    // in user-space — same coord system as the shape's own attrs — so the
    // outer half of the centered stroke gets cleanly clipped without the
    // CSS-vs-user-space ambiguity that breaks `clip-path: path()`.
    const defs = ensureSvgDefs(parentSvg);
    let cp = defs.querySelector(`#${CSS.escape(clipId)}`) as SVGElement | null;
    if (!cp) {
      cp = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
      cp.setAttribute('id', clipId);
      defs.appendChild(cp);
    } else {
      // Wipe previous geometry so an attr change (resize, reshape) doesn't
      // accumulate stale clip paths.
      while (cp.firstChild) cp.removeChild(cp.firstChild);
    }
    // Clone just the geometry attrs onto an element of the same tag inside
    // the clipPath. fill/stroke/etc. are ignored by clipPath but we drop
    // them anyway to keep the def lean.
    const GEOMETRY_ATTRS = new Set([
      'd', 'points', 'x', 'y', 'width', 'height', 'rx', 'ry',
      'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'transform',
    ]);
    const geom = document.createElementNS('http://www.w3.org/2000/svg', type);
    for (const a of Array.from(el.attributes)) {
      if (GEOMETRY_ATTRS.has(a.name)) geom.setAttribute(a.name, a.value);
    }
    cp.appendChild(geom);
    if (el.getAttribute('clip-path') !== `url(#${clipId})`) {
      el.setAttribute('clip-path', `url(#${clipId})`);
    }
    removeCanvasCSS(cssSelector);  // no CSS path needed for inside any more
  } else if (align === 'outside') {
    injectCanvasCSS(cssSelector, `paint-order: stroke fill;`);
  } else {
    removeCanvasCSS(cssSelector);
  }
}

/**
 * Overflow the INSTANCE WRAPPER must carry, mirrored from the component
 * ROOT's resolved styles.
 *
 * The canvas renders an instance as TWO divs (wrapper + inner root) while the
 * live site renders ONE (the master root, carrying the instance styles via the
 * `...style` spread). The wrapper — not the inner root — is the actual FLEX
 * ITEM in the parent layout, and CSS's automatic-minimum-size rule keys off
 * the flex item's own overflow: `min-width/min-height: auto` resolves to the
 * content size when the item's overflow is `visible`, but to 0 when it clips
 * (hidden/clip/auto/scroll). So a clipping master root on the live site lets
 * `flex-basis: 0` collapse the instance below its content size — while the
 * canvas's old hard-coded `wrapper.overflow = 'visible'` pinned the minimum at
 * content size and silently masked the collapse (live find 2026-07-05: an
 * AboutPoint row flipped to column showed full cards on the canvas tablet
 * tile but half-cut cards on the live site).
 *
 * Mirroring the root's clipping overflow onto the wrapper restores parity:
 * same flex item, same min-size behaviour, same clip. Returns 'visible' when
 * the root doesn't clip (the wrapper's historical default).
 */
export function resolveInstanceWrapperOverflow(
  rootStyles: Record<string, unknown> | null | undefined,
): string {
  const o = rootStyles?.overflow;
  return typeof o === 'string' && o.trim() !== '' ? o : 'visible';
}

/**
 * Set a single inline style key, handling CSS custom properties correctly.
 * `el.style['--foo'] = v` (bracket/property assignment) is a SILENT NO-OP for
 * custom properties — the CSSStyleDeclaration only accepts them via
 * `setProperty`. Component overlay-border variables bind through a custom
 * property (`--X` on the root, `border: var(--X)` in the injected `::after`),
 * so without this the canvas never applies `--X` and `var(--X)` resolves to
 * empty — the overlay border vanishes (notably after a re-render once the
 * BorderControl's imperative resolved-value injection clears). Camel-case keys
 * keep using property assignment (the existing fast path).
 */
export function setElStyle(el: HTMLElement, key: string, v: string): void {
  // Canvas image previews swap backgroundImage for a downscaled blob URL —
  // when this element already paints the preview OF exactly this value, the
  // write must be skipped or every patch cycle would restore the original and
  // re-decode the full bitmap (see canvas-image-preview.ts).
  if (key === 'backgroundImage' && isPreviewAppliedBg(el, v)) return;
  if (key.startsWith('--')) {
    try { el.style.setProperty(key, v); } catch { /* skip invalid */ }
  } else {
    // Coerce a bare-number value to px for px-properties (React-equivalent) so raw-number VARIABLES
    // (`gap = 61`) render — `el.style.gap = "61"` is invalid CSS. See coerceCssNumberToPx.
    try { (el.style as any)[key] = coerceCssNumberToPx(key, v); } catch { /* skip invalid */ }
  }
}

/** Clear a single inline style key, handling CSS custom properties (see setElStyle). */
export function clearElStyle(el: HTMLElement, key: string): void {
  if (key.startsWith('--')) {
    try { el.style.removeProperty(key); } catch { /* skip invalid */ }
  } else {
    try { (el.style as any)[key] = ''; } catch { /* skip invalid */ }
  }
}
