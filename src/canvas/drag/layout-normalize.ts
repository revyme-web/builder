// layout-normalize.ts — makes ANY plugin-supplied layout tree
// (canvas.startLayoutDrag) well-formed and oracle-compliant BEFORE it becomes
// real nodes. The SDK gives plugin authors primitives (a tree of tags + inline
// styles); the HOST guarantees the result renders + edits correctly, exactly
// like the Insert panel's own items do. This means a plugin author writes a
// naive tree by hand and never has to know the editor's node dialect — the same
// rules the oracle (checkFile) enforces on AI output are auto-applied here.
//
// What it enforces (the structural rules that otherwise break rendering, all
// derived from src/code/oracle/checks/layout-rules.ts + style-object.ts):
//   • NODE_MISSING_POSITION      — every node gets an explicit `position`
//     ('relative' default; author-set absolute/fixed/sticky preserved).
//   • TRANSPARENT_COLOR          — the literal 'transparent' → 'rgba(0,0,0,0)'.
//   • FORBIDDEN_ALIGN_VALUE      — drop alignItems 'stretch'/'baseline'.
//   • PADDING_NEEDS_LAYOUT       — a padded <div> with no layout display gets
//     display:flex + flexDirection:column (closest to block stacking).
//   • FLEX_CHILD_MISSING_ORDER   — every in-flow child of a flex/grid container
//     gets a sequential quoted `order` ('0','1',…).
//   • FLEX_CHILD_SHRINKS         — every child of a FLEX (not grid) container
//     is forced to flex-shrink 0 ('0 0 auto' Hug / '<grow> 0 <basis>' Fill).
//
// Pure + mutating (the descriptor arrives as a fresh postMessage clone, so
// mutating in place is safe). No DOM, no bridge — unit-testable.
import type { NewNodeDescriptor } from '@/shared/types';
import { TRANSPARENT_FILL } from '@/shared/css-utils';
import { sanitizeSvgMarkupForJsx } from '@/shared/svg-sanitize';
import { normalizeSvgGeometryToBox } from '@/shared/icon-viewbox';
import { decomposeSvgDropToShapes } from './svg-drop-shapes';
import { trace } from '@/shared/debug-trace';

const LAYOUT_DISPLAYS = new Set(['flex', 'inline-flex', 'grid', 'inline-grid']);
const isFlex = (d?: string) => d === 'flex' || d === 'inline-flex';
const isGrid = (d?: string) => d === 'grid' || d === 'inline-grid';
const isDivTag = (tag: string) => tag === 'div' || tag === 'motion.div';
const PADDING_KEYS = ['padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];

/** Non-zero padding present (a bare '0'/'0px' doesn't count — matches the oracle). */
function hasRealPadding(styles: Record<string, string>): boolean {
  return PADDING_KEYS.some((k) => typeof styles[k] === 'string' && /[1-9]/.test(styles[k]));
}

/** Force flex-shrink to 0 in place, preserving grow/basis intent. */
function forceNonShrink(styles: Record<string, string>): void {
  if (styles.flexShrink === '0') return;
  const f = styles.flex;
  if (!f) { styles.flex = '0 0 auto'; return; }               // Hug
  const p = f.trim().split(/\s+/);
  if (p.length >= 3) { p[1] = '0'; styles.flex = p.slice(0, 3).join(' '); return; }  // grow shrink basis
  if (p.length === 2) {
    if (/^-?\d/.test(p[1])) { p[1] = '0'; styles.flex = p.join(' '); }               // grow shrink
    else styles.flex = `${p[0]} 0 ${p[1]}`;                                          // grow basis → shrink 0
    return;
  }
  styles.flex = `${p[0]} 0 0px`;                                                     // single grow (Fill)
}

/** JSX text can't contain a raw `<` or `{` (they start a tag / expression), so a
 *  plugin author writing e.g. "<50ms" or "{count}" as literal copy would emit
 *  unparseable code. Entity-escape them (JSX decodes entities back on render). */
function escapeJsxText(s: string): string {
  return s.replace(/</g, '&lt;').replace(/{/g, '&#123;').replace(/}/g, '&#125;');
}

/** Recursively normalize a layout descriptor tree (mutates + returns it). */
export function normalizeLayoutDescriptor(node: NewNodeDescriptor, insideSvg = false): NewNodeDescriptor {
  // Inside an <svg>, textContent IS markup (`<path d="…"/>`), the same inner-
  // markup contract assets.addSvg uses — entity-escaping it would corrupt the
  // shape (a brand-logo plugin dropping a native vector was the live find,
  // 2026-07-28). It gets the SVG sanitizer instead: real-world exports carry
  // XML comments / `<style>{…}</style>` / namespaced attrs that are valid XML
  // but crash the JSX parse — the add-mutation then silently vanished.
  // Text elements everywhere else keep the escape.
  const inSvg = insideSvg || node.tag === 'svg';
  if (typeof node.textContent === 'string') {
    node.textContent = inSvg ? sanitizeSvgMarkupForJsx(node.textContent) : escapeJsxText(node.textContent);
  }
  // Nodes INSIDE an svg subtree (nested shape svgs / paths from the shape
  // grammar) are SVG content, not CSS boxes — the layout rules below
  // (position injection, flex/order, padding) would pollute the grammar the
  // Figma import established. Sanitize + recurse only.
  if (insideSvg) {
    for (const child of node.children ?? []) normalizeLayoutDescriptor(child, true);
    return node;
  }
  const styles = (node.styles ??= {});

  // SHAPE DIALECT — a dropped vector must become the builder's native shape
  // grammar or the editor can't edit it (resize geometry baking, shape edit
  // and rotate all assume `viewBox === 0 0 W H` px; and vertices/per-shape
  // fills only exist for REAL path children — flat inner markup rendered but
  // showed no vertices at all, user report 2026-07-28).
  //  1. Decompose into the Figma-import grammar: wrapper svg → per-shape
  //     nested svg children → single <path> each, geometry scaled to px.
  //  2. Decompose bails (masks/gradients/filters/…): try a flat 1:1 geometry
  //     rescale so at least the resize math stays honest.
  //  3. That bails too: keep the source viewBox — renders correctly, just
  //     not natively editable (same "better lingering than mangled" policy
  //     as icon drops).
  if (node.tag === 'svg' && typeof node.textContent === 'string' && node.textContent.trim()) {
    const vb = node.attrs?.viewBox;
    const w = parseFloat(styles.width ?? '');
    const h = parseFloat(styles.height ?? '');
    if (vb && Number.isFinite(w) && Number.isFinite(h)) {
      // Decompose only when the node has its REAL id (the drop strategy's
      // normalize pass) — shape/path child ids derive from it (`-s<i>`,
      // `-g0`). The bridge's earlier id-less pass just sanitizes.
      const dec = node.id
        ? decomposeSvgDropToShapes(`<svg viewBox="${vb}">${node.textContent}</svg>`, node.id, node.name ?? '', w, h)
        : null;
      if (dec) {
        node.textContent = undefined;
        node.attrs = { ...(node.attrs ?? {}), ...dec.attrs };
        node.children = dec.children;
        styles.overflow = 'visible';
        // Adopt the shrink-wrapped box: the decompose rebases geometry to
        // the painted bbox, dropping icon-pack padding — the wrapper's CSS
        // box must follow or the shape paints stretched into the old
        // padded dimensions (viewBox is 1:1 with the TIGHT box now).
        styles.width = `${dec.box.w}px`;
        styles.height = `${dec.box.h}px`;
        trace.action('layout-normalize:svg-decomposed', { baseId: node.id, shapes: dec.children.length, w: dec.box.w, h: dec.box.h });
      } else {
        const oneToOne = normalizeSvgGeometryToBox(vb, node.textContent, w, h);
        if (oneToOne) {
          node.attrs = { ...(node.attrs ?? {}), viewBox: oneToOne.viewBox };
          node.textContent = oneToOne.inner;
          trace.action('layout-normalize:svg-1to1', { from: vb, to: oneToOne.viewBox });
        }
      }
    }
  }

  // TRANSPARENT_COLOR — swap the literal 'transparent' on ANY property.
  // Shared with the editor's own write path (node-ops) so plugin trees and
  // builder edits normalise identically.
  for (const k of Object.keys(styles)) {
    if (styles[k] === 'transparent') styles[k] = TRANSPARENT_FILL;
  }
  // SOLID FILL → backgroundColor. The editor's Fill control reads/writes
  // `backgroundColor` for a solid colour; a solid put on the `background`
  // shorthand renders but shows as an EMPTY, uneditable fill in the panel.
  // Move it. Gradients / images stay on `background` / `backgroundImage`.
  const bg = styles.background;
  if (typeof bg === 'string' && bg.trim() && !/gradient|url\(|image-set/i.test(bg)) {
    if (!styles.backgroundColor) styles.backgroundColor = bg;
    delete styles.background;
  }
  // NODE_MISSING_POSITION — every node needs an explicit position.
  if (!styles.position) styles.position = 'relative';
  // POSITION_OFFSET_REQUIRES_ABSOLUTE — offsets only PLACE an absolute/fixed/
  // sticky node. Defaulting to 'relative' above (or an author's own 'relative')
  // leaves any left/top the descriptor carried as dead CSS that still reads as a
  // PIN to the Position tool ('0px' matches its detector), so drop them here
  // rather than shipping a node whose panel lies about its own state.
  if (styles.position === 'relative' || styles.position === 'static') {
    for (const k of ['left', 'top', 'right', 'bottom'] as const) delete styles[k];
  }
  // FORBIDDEN_ALIGN_VALUE — omit stretch/baseline (CSS default is stretch).
  if (styles.alignItems === 'stretch' || styles.alignItems === 'baseline') delete styles.alignItems;
  // PADDING_NEEDS_LAYOUT — a padded div must declare a layout.
  if (isDivTag(node.tag) && hasRealPadding(styles) && !LAYOUT_DISPLAYS.has(styles.display)) {
    styles.display = 'flex';
    if (!styles.flexDirection) styles.flexDirection = 'column';
  }

  const kids = node.children ?? [];
  const flexParent = isFlex(styles.display);
  const gridParent = isGrid(styles.display);
  if (flexParent || gridParent) {
    let flowIdx = 0;
    for (const child of kids) {
      const cs = (child.styles ??= {});
      // Absolutely-positioned children are exempt from order + shrink.
      if (cs.position === 'absolute' || cs.position === 'fixed') continue;
      if (cs.order === undefined) cs.order = String(flowIdx);   // quoted string on emit
      if (flexParent) forceNonShrink(cs);                        // grid items exempt from shrink rule
      flowIdx++;
    }
  }
  for (const child of kids) normalizeLayoutDescriptor(child, inSvg);

  return node;
}
