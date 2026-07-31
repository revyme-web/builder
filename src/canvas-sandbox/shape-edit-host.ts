// shape-edit-host.ts — Sandbox-side SvgPathEditor lifecycle.
//
// Why this lives in the sandbox: the editor mounts directly on the actual
// SVG element being edited, in the SAME coord space as the path content.
// All anchor drag events stay in the iframe; the parent only learns about
// the result on commit. That eliminates:
//   • Comlink round-trips per pointermove (was 60+/s during drag)
//   • Async `getBBox` gaps on exit (5-10 ms paint window where the
//     wrapper hadn't caught up to the new path)
//   • Coordinate-space mismatches between parent's screen rect and
//     iframe's rendered geometry under canvas zoom/pan
//
// Communication with the parent:
//   • Commands in: parent calls startShapeEdit / commitShapeEdit /
//     cancelShapeEdit via Comlink (see SandboxApi).
//   • Events out: on commit, emits `shapeEditCommitted` with both the
//     new inner SVG markup AND the normalized wrapper bounds, so the
//     host can write both to source in a single mutation cycle.

import { SvgPathEditor } from '@/svg-editor';
import type { SvgEditorAdapter } from '@/svg-editor';
import type { SandboxEvent } from './protocol';
import { wrapEvent } from './protocol';
import { trace } from '@/shared/debug-trace';
import {
  getSvgWrapperViewBoxAffine, affineToDOMMatrix, type Affine, type SvgCtmContext,
} from './svg-user-to-screen';
import { geometryVertices } from '@/shared/svg-geometry';
import { parseRotateTransform, r3 } from '@/code/svg/group-resize-bake';
import { findElByNodeId } from './sandbox-dom-utils';

// `emit` only needed for the cancel event (Escape from inside iframe);
// commit is a synchronous return value via Comlink, no event needed.

// ─── Module state ────────────────────────────────────────────────────────

let activeEditor: SvgPathEditor | null = null;
// rAF retry counter for startShapeEdit when a just-committed node (path tool's
// draw → auto-enter editor) isn't in the iframe DOM yet. Reset once found.
let _startShapeEditRetries = 0;
// True while the PATH TOOL is drawing a new shape (pen mode). The seed node is
// viewport-sized so the pen can draw anywhere; we must NOT shrink it to the path
// bbox on every vertex-release (that's what stranded the draw beyond a small box
// after the first edit). The final shrink happens once in commitShapeEdit.
let activePenMode = false;
// True once the user actually edits the path during this session (the editor's
// onChange fires). A shape-edit that's just entered + exited with NO edit must
// be a TRUE no-op — committing it re-serializes the shape (turning a <polygon>
// into a <path> and stamping ids), which then breaks a later variant resize.
let activeEditDirty = false;
let activeNodeId: string | null = null;
let activeVpPrefix: string = '';
let activeSvg: SVGSVGElement | null = null;
let activeOverlayContainer: HTMLDivElement | null = null;
let initialMarkupRef: string = '';
let currentMarkupRef: string = '';
let isDragging = false;
let pendingInnerJSX: string | null = null;
let contentRoot: HTMLElement | null = null;

/** Style element that paints the edit-time outline / hides hover overlays. */
let editStyleEl: HTMLStyleElement | null = null;

// ─── Unified SVG matrix context ──────────────────────────────────────────────
// Canvas zoom for the deterministic user-space→screen matrix. Read from the
// content root's CSS transform (the canvas pan/zoom lives there as
// `translate3d(...) scale(s)`); the scale magnitude is √(a²+b²).
function getCanvasZoom(): number {
  if (!contentRoot) return 1;
  try {
    const t = getComputedStyle(contentRoot).transform;
    if (t && t !== 'none') { const m = new DOMMatrix(t); const s = Math.hypot(m.a, m.b); if (s > 0) return s; }
  } catch { /* ignore */ }
  return 1;
}
function innerAffineAdapter(svg: SVGSVGElement): Affine | null {
  const m = getInnerShapeTransformMatrix(svg);
  return m ? [m.a, m.b, m.c, m.d, m.e, m.f] : null;
}
function svgCtmContext(): SvgCtmContext {
  return { contentRoot, zoom: getCanvasZoom(), innerShapeAffine: innerAffineAdapter };
}

/** Initialize the host with the sandbox's content root so it can find elements. */
export function initShapeEditHost(root: HTMLElement): void {
  contentRoot = root;
  trace.action('shape-edit-host:init');
}

/** Send an event to the parent. Mirrors text-edit-host's helper. */
function emit(event: SandboxEvent): void {
  parent.postMessage(wrapEvent(event), '*');
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Closed-form solver for a viewBox→screen 2D affine matrix from 3 mapped
 * corners. The corners are the screen positions of:
 *
 *     (vbX, vbY)         → TL
 *     (vbX + vbW, vbY)   → TR
 *     (vbX, vbY + vbH)   → BL
 *
 * 6 equations / 6 unknowns (a, b, c, d, e, f):
 *   a = (TR.x - TL.x) / vbW    c = (BL.x - TL.x) / vbH
 *   b = (TR.y - TL.y) / vbW    d = (BL.y - TL.y) / vbH
 *   e = TL.x - a·vbX - c·vbY   f = TL.y - b·vbX - d·vbY
 *
 * Returns the DOMMatrix coefficient tuple, or null when the viewBox has no
 * area or the corners form a degenerate (zero-area) basis — callers fall
 * through to the next CTM strategy in that case.
 *
 * Pure (no DOM) so the matrix math is unit-testable; the live-DOM corner
 * sourcing (getBoxQuads / nested-in-group screen rect) stays in the callers.
 */
export function solveViewBoxAffine(
  TL: { x: number; y: number },
  TR: { x: number; y: number },
  BL: { x: number; y: number },
  vb: { x: number; y: number; width: number; height: number },
): [number, number, number, number, number, number] | null {
  const { x: vbX, y: vbY, width: vbW, height: vbH } = vb;
  if (!vbW || !vbH) return null;
  const a = (TR.x - TL.x) / vbW;
  const b = (TR.y - TL.y) / vbW;
  const c = (BL.x - TL.x) / vbH;
  const d = (BL.y - TL.y) / vbH;
  const e = TL.x - a * vbX - c * vbY;
  const f = TL.y - b * vbX - d * vbY;
  // Reject a degenerate basis (0×0 box → all basis vectors ~0). Nested SVGs
  // inside a group can report empty getBoxQuads in some browsers.
  const basisMag = Math.abs(a) + Math.abs(b) + Math.abs(c) + Math.abs(d);
  if (basisMag <= 1e-6) return null;
  return [a, b, c, d, e, f];
}

/**
 * Screen-space rect of a nested-in-group `<svg>`, given the parent SVG's
 * on-screen rect + the parent's viewBox and the nested SVG's
 * `x`/`y`/`width`/`height` attributes.
 *
 * The nested SVG's positioning attrs live in the PARENT's viewBox user
 * space — so the parent viewBox's ORIGIN (not just its size) must be
 * subtracted. `refitGroupBounds` / `normalizeGroupOnResize` can leave a
 * group with a non-zero (often negative) viewBox origin; ignoring it
 * offset the overlay by `origin × scale` px — the anchor handles drifted
 * up/left of the painted shape on any reshaped/rotated group.
 *
 * `width`/`height` of the parent viewBox fall back to the parent's screen
 * rect when absent (a group with no viewBox renders 1:1).
 *
 * Pure (no DOM) so the math is unit-testable; the live-DOM attribute
 * sourcing stays in `getActiveSvgScreenRect`.
 */
export function nestedSvgScreenRect(
  parentRect: { left: number; top: number; width: number; height: number },
  parentViewBox: { x: number; y: number; width: number; height: number },
  nested: { x: number; y: number; width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  const pVbW = parentViewBox.width || parentRect.width || 1;
  const pVbH = parentViewBox.height || parentRect.height || 1;
  const scaleX = parentRect.width / pVbW;
  const scaleY = parentRect.height / pVbH;
  return {
    left: parentRect.left + (nested.x - parentViewBox.x) * scaleX,
    top: parentRect.top + (nested.y - parentViewBox.y) * scaleY,
    width: nested.width * scaleX,
    height: nested.height * scaleY,
  };
}

/** SVG geometry-element tags — the shapes that carry path/point data and
 *  (childIndex:0) the rotation `transform` attribute. Deliberately excludes
 *  `<g>` / `<defs>` / nested `<svg>` (those are containers, not geometry). */
const SVG_GEOMETRY_TAGS = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path']);

/** First geometry-shape child of an `<svg>` wrapper (path/polygon/rect/…),
 *  skipping `<defs>`, `<g>`, nested `<svg>`, renderer-injected nodes. This
 *  is the element shape rotation is written to — "Rotation targets
 *  childIndex: 0". */
export function firstSvgShapeChild(svg: SVGSVGElement): SVGGraphicsElement | null {
  for (const child of Array.from(svg.children)) {
    if (SVG_GEOMETRY_TAGS.has(child.tagName.toLowerCase())) {
      return child as SVGGraphicsElement;
    }
  }
  return null;
}

/** Live group auto-fit (shared by the bridge `liveRefitGroup` command and the
 *  shape-edit reshape). Re-fit a FLEX SVG group to its children's PAINTED bounds
 *  (rotated bbox for rotated children) SYNCHRONOUSLY each frame — by moving the
 *  viewBox ORIGIN to the content min and resizing the box, WITHOUT re-basing the
 *  children (so it's idempotent — no per-tick sibling drift). Paints identically
 *  to the commit (`moveChildAndRefitGroup` re-bases to origin 0). Returns true if
 *  it refit. Bails for absolute/fixed groups (those need a snapshot-baselined
 *  left/top — they stay on the commit-time refit). See the rotated-group-refit
 *  lesson. */
const LIVE_REFIT_GEOM_KEYS = ['d', 'points', 'x', 'y', 'width', 'height', 'cx', 'cy', 'rx', 'ry', 'r', 'x1', 'y1', 'x2', 'y2'];
const r3live = (n: number) => Math.round(n * 1000) / 1000;

/** A child `<svg>`'s ACTUAL painted VERTICES in its PARENT's user space. Vertices,
 *  NOT a recursive AABB: collapsing a child to its AABB and then rotating that
 *  AABB by an ancestor's rotation over-reaches into the AABB's EMPTY corners. With
 *  BOTH a rotated leaf geometry AND a rotated parent group (group ▸ group ▸
 *  rotated-shape) the double rotation inflates the top box by hundreds of px → a
 *  gap on one side. Carrying real vertices and AABB-ing once at the top is the only
 *  tight result. Mirrors the SOURCE `paintedVerticesInGroup` and the selection's
 *  `paintedGroupUserBounds`, so box == selection == tight to the painted content. */
function paintedVerticesDOM(cs: SVGSVGElement): Array<[number, number]> {
  const x = parseFloat(cs.getAttribute('x') || '0') || 0;
  const y = parseFloat(cs.getAttribute('y') || '0') || 0;
  const w = parseFloat(cs.getAttribute('width') || '0') || 0;
  const h = parseFloat(cs.getAttribute('height') || '0') || 0;
  const vb = (cs.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const vbx = vb[0] || 0, vby = vb[1] || 0, vbw = vb[2] || w, vbh = vb[3] || h;
  if (!(vbw > 0) || !(vbh > 0)) return [];
  const sxBox = w / vbw, syBox = h / vbh;
  // Map a vertex from cs's USER (viewBox) space → its PARENT space: viewBox
  // scale+translate, then cs's OWN rotation about its pivot.
  const crot = parseRotateTransform(cs.getAttribute('transform') || undefined);
  const crad = (crot?.angle ?? 0) * (Math.PI / 180), ccos = Math.cos(crad), csin = Math.sin(crad);
  const toParent = ([ux, uy]: [number, number]): [number, number] => {
    const px = x + (ux - vbx) * sxBox, py = y + (uy - vby) * syBox;
    if (!crot) return [px, py];
    const dx = px - crot.cx, dy = py - crot.cy;
    return [crot.cx + dx * ccos - dy * csin, crot.cy + dx * csin + dy * ccos];
  };
  const boxCorners = (): Array<[number, number]> =>
    ([[vbx, vby], [vbx + vbw, vby], [vbx + vbw, vby + vbh], [vbx, vby + vbh]] as Array<[number, number]>).map(toParent);

  const geomEl = firstSvgShapeChild(cs) as SVGElement | null;
  if (geomEl) {
    const attrs: Record<string, string> = {};
    for (const k of LIVE_REFIT_GEOM_KEYS) { const v = geomEl.getAttribute(k); if (v != null) attrs[k] = v; }
    let verts = geometryVertices(geomEl.tagName.toLowerCase(), attrs);
    if (verts.length === 0) {
      // %-based shape (`<ellipse rx="50%">`) fills its viewBox — geometryVertices
      // returns []. Use the viewBox corners as the LOCAL geometry so the shape's
      // own rotation (grot) still applies; boxCorners() maps only the wrapper
      // rotation and would drop grot (rotated circle bounds come out un-rotated).
      verts = [[vbx, vby], [vbx + vbw, vby], [vbx + vbw, vby + vbh], [vbx, vby + vbh]];
    }
    const grot = parseRotateTransform(geomEl.getAttribute('transform') || undefined);
    if (grot) {
      const a = (grot.angle * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
      verts = verts.map(([px, py]): [number, number] => {
        const dx = px - grot.cx, dy = py - grot.cy;
        return [grot.cx + dx * cos - dy * sin, grot.cy + dx * sin + dy * cos];
      });
    }
    return verts.map(toParent);
  }
  // GROUP child: recurse for each grandchild's vertices, map up to parent space.
  const out: Array<[number, number]> = [];
  for (const gc of Array.from(cs.children)) {
    if (gc.tagName.toLowerCase() !== 'svg') continue;
    for (const v of paintedVerticesDOM(gc as SVGSVGElement)) out.push(toParent(v));
  }
  return out.length ? out : boxCorners();
}

/** AABB of a child `<svg>`'s painted vertices in its PARENT's user space. */
function childPaintedBoundsDOM(cs: SVGSVGElement): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const verts = paintedVerticesDOM(cs);
  if (verts.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [px, py] of verts) {
    if (px < minX) minX = px; if (py < minY) minY = py;
    if (px > maxX) maxX = px; if (py > maxY) maxY = py;
  }
  return { minX, minY, maxX, maxY };
}

/** Union of a group's children's PAINTED bounds in the group's OWN user space —
 *  recursive + per-grandchild rotation (tight). Null when no measurable children. */
function groupContentUnion(groupEl: SVGSVGElement): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let count = 0;
  for (const child of Array.from(groupEl.children)) {
    if (child.tagName.toLowerCase() !== 'svg') continue;
    const b = childPaintedBoundsDOM(child as SVGSVGElement);
    if (!b) continue;
    if (b.minX < minX) minX = b.minX; if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX; if (b.maxY > maxY) maxY = b.maxY;
    count++;
  }
  if (count === 0 || !Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/** Live group auto-fit (shared by the bridge `liveRefitGroup` command and the
 *  shape-edit reshape). Re-fit a TOP-LEVEL FLEX SVG group (box in CSS) to its
 *  children's PAINTED bounds SYNCHRONOUSLY each frame — by moving the viewBox
 *  ORIGIN to the content min and resizing the CSS box, WITHOUT re-basing the
 *  children (idempotent — no per-tick sibling drift). Paints identically to the
 *  commit (`moveChildAndRefitGroup` re-bases to origin 0). Bails for
 *  absolute/fixed (commit-time refit) and for NESTED groups (use
 *  `liveRefitNestedGroupEl` — they're sized by ATTRIBUTES, so `style.width` is
 *  ignored). */
function liveRefitGroupEl(groupEl: SVGSVGElement): boolean {
  if (groupEl.tagName.toLowerCase() !== 'svg') return false;
  if (groupEl.style.position === 'absolute' || groupEl.style.position === 'fixed') return false;
  if (groupEl.parentElement?.tagName.toLowerCase() === 'svg') return false;
  const u = groupContentUnion(groupEl);
  if (!u) return false;
  const newW = r3live(u.maxX - u.minX), newH = r3live(u.maxY - u.minY);
  if (!(newW > 0) || !(newH > 0)) return false;
  groupEl.style.width = `${newW}px`;
  groupEl.style.height = `${newH}px`;
  groupEl.setAttribute('viewBox', `${r3live(u.minX)} ${r3live(u.minY)} ${newW} ${newH}`);
  if (/rotate\(/.test(groupEl.style.transform || '')) {
    groupEl.style.transformOrigin = `${r3live(newW / 2)}px ${r3live(newH / 2)}px`;
  }
  return true;
}


/** Live auto-fit for a NESTED group (box in `x/y/width/height` ATTRIBUTES). Same
 *  idempotent non-rebasing refit as `liveRefitGroupEl`, but writes ATTRS and
 *  compensates x/y so the painted content stays put as the viewBox origin moves
 *  to the content min. Keeps a rotated nested group's `transform` pivot at the
 *  new box centre. Visually identical to the attribute commit (`rewriteGroupOpen`
 *  re-bases to origin 0), so no mouseup jump. */
function liveRefitNestedGroupEl(groupEl: SVGSVGElement): boolean {
  if (groupEl.tagName.toLowerCase() !== 'svg') return false;
  const u = groupContentUnion(groupEl);
  if (!u) return false;
  const newVbW = r3live(u.maxX - u.minX), newVbH = r3live(u.maxY - u.minY);
  if (!(newVbW > 0) || !(newVbH > 0)) return false;
  const oldVb = (groupEl.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const oldVbX = oldVb[0] || 0, oldVbY = oldVb[1] || 0, oldVbW = oldVb[2] || 0, oldVbH = oldVb[3] || 0;
  const oldX = parseFloat(groupEl.getAttribute('x') || '0') || 0;
  const oldY = parseFloat(groupEl.getAttribute('y') || '0') || 0;
  const oldBoxW = parseFloat(groupEl.getAttribute('width') || '0') || oldVbW;
  const oldBoxH = parseFloat(groupEl.getAttribute('height') || '0') || oldVbH;
  const scaleX = oldVbW > 0 ? oldBoxW / oldVbW : 1;
  const scaleY = oldVbH > 0 ? oldBoxH / oldVbH : 1;
  const newBoxW = r3live(newVbW * scaleX), newBoxH = r3live(newVbH * scaleY);
  // x/y compensate for the viewBox-origin move so the content doesn't shift.
  // The plain compensation (translate only) keeps the content fixed for an
  // UN-rotated group. For a ROTATED group the rotate pivot ALSO moves to the new
  // box centre, which shifts the rotated result by (I−R)(O_old−O_new); the box
  // must compensate for THAT too — identical to the commit's `rotatedRefitPosition`
  // so live == mouseup. Shift in box px: (minX − oldVbX)·scale.
  const tr0 = groupEl.getAttribute('transform') || '';
  const rotM = tr0.match(/rotate\(\s*(-?[\d.]+)/);
  let newX: number, newY: number;
  if (rotM) {
    const ang = (parseFloat(rotM[1]) || 0) * (Math.PI / 180);
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const rx = (vx: number, vy: number) => cos * vx - sin * vy;
    const ry = (vx: number, vy: number) => sin * vx + cos * vy;
    const sX = (u.minX - oldVbX) * scaleX, sY = (u.minY - oldVbY) * scaleY;
    const ox = oldBoxW / 2 - newBoxW / 2, oy = oldBoxH / 2 - newBoxH / 2; // O_old − O_new (box-local)
    newX = r3live(oldX + (ox - rx(ox, oy)) + rx(sX, sY));
    newY = r3live(oldY + (oy - ry(ox, oy)) + ry(sX, sY));
  } else {
    newX = r3live(oldX + (u.minX - oldVbX) * scaleX);
    newY = r3live(oldY + (u.minY - oldVbY) * scaleY);
  }
  groupEl.setAttribute('width', `${newBoxW}`);
  groupEl.setAttribute('height', `${newBoxH}`);
  groupEl.setAttribute('x', `${newX}`);
  groupEl.setAttribute('y', `${newY}`);
  groupEl.setAttribute('viewBox', `${r3live(u.minX)} ${r3live(u.minY)} ${newVbW} ${newVbH}`);
  // Rotated nested group: keep the `transform="rotate(θ cx cy)"` pivot at the
  // new box centre (parent space).
  const tr = groupEl.getAttribute('transform');
  if (tr && tr.includes('rotate(')) {
    const pcx = r3live(newX + newBoxW / 2), pcy = r3live(newY + newBoxH / 2);
    groupEl.setAttribute('transform', tr.replace(
      /rotate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/,
      (_m, a) => `rotate(${a} ${pcx} ${pcy})`,
    ));
  }
  return true;
}

/** Live auto-fit the WHOLE `<svg>`-group ancestor chain of `leafGroupEl`,
 *  bottom-up — so manipulating a deeply-nested shape re-fits its nested group AND
 *  every group above it LIVE, up to the top-level group. ONLY runs when that
 *  top-level group is in LAYOUT (a flex/flow child, NOT absolute) — there, the
 *  top-level refit changes its CSS box and the layout reflows EACH FRAME (what
 *  the user wants when the group tree sits in a flex layout). On the CANVAS
 *  (absolute top), it bails → commit-time refit only (no live box churn). */
export function liveRefitGroupChainEl(leafGroupEl: SVGSVGElement): boolean {
  // Build the bottom-up chain of svg-group ancestors + find the top-level group.
  const chain: SVGSVGElement[] = [];
  let cur: Element | null = leafGroupEl;
  while (cur && cur.tagName && cur.tagName.toLowerCase() === 'svg' && cur !== contentRoot) {
    chain.push(cur as SVGSVGElement);
    const p: Element | null = cur.parentElement;
    if (p && p.tagName && p.tagName.toLowerCase() === 'svg') { cur = p; continue; }
    break;
  }
  const top = chain[chain.length - 1];
  if (!top) return false;
  // Gate: only when the top-level group is in LAYOUT (non-absolute). The canvas
  // (absolute) case stays on commit-time refit. An attempted per-tick DOM refit
  // for absolute tops (2026-07-28) fed back into itself: sliding the group's
  // left/top moved the very parent frame the child drag computes coordinates
  // in, and re-measuring the painted union against the mid-update DOM ran the
  // viewBox away (250×64 → 304×153 with a stationary child) — the dragged
  // shape "offset completely". Live group-outline expansion for absolute tops
  // is drawn by the ParentHighlight OVERLAY instead (pure screen math, no DOM
  // feedback).
  if (top.style.position === 'absolute' || top.style.position === 'fixed') return false;
  let any = false;
  for (const g of chain) {
    const nested = g.parentElement?.tagName.toLowerCase() === 'svg';
    any = (nested ? liveRefitNestedGroupEl(g) : liveRefitGroupEl(g)) || any;
  }
  return any;
}

/** Serialize the SVG node tree starting at `svg` into raw markup the
 *  library can parse. Output uses kebab-case attrs (XML standard).
 *  Synthesizes a viewBox + preserveAspectRatio from the wrapper's CSS
 *  width/height when the SVG lacks them — same logic the legacy parent-
 *  frame overlay used (`nodeTreeToSvgMarkup`). */
/**
 * Screen-space rect for the currently-edited SVG. Mirrors what a naive
 * `activeSvg.getBoundingClientRect()` would do, BUT handles the
 * nested-SVG case (group children) where `getBoundingClientRect` is
 * unreliable.
 *
 * Why nested SVGs need manual computation: when a `<svg x y width
 * height viewBox>` lives inside another `<svg>` (no CSS box, just SVG
 * positioning attrs), browsers report inconsistent bounds — sometimes
 * (0,0,0,0), sometimes the parent's full content area, sometimes the
 * union of painted children. None of those match the "200×200 area at
 * (DX, DY) inside parent viewBox" semantics the editor needs.
 *
 * Symptom of using the wrong rect: anchor handles cluster small at the
 * top of a grouped vector instead of overlaying the painted shape, and
 * dragging them maps coords through a broken transform so the path
 * morphs in random directions.
 *
 * Manual formula: parent's screen rect + nested SVG's (x, y, width,
 * height) attrs scaled by parent's viewBox→screen ratio.
 */
/**
 * Build the full user-space → screen DOMMatrix for the active SVG,
 * INCLUDING all CSS transforms in the chain (the new individual
 * `rotate` / `scale` / `translate` properties, the `transform` property,
 * parent transforms, canvas pan/zoom).
 *
 * Method: read the 4 visible CSS-box corners via `getBoxQuads({ box: 'border' })`.
 * Those corners are the EXACT screen positions the browser uses to render
 * the SVG — every CSS transform on the element and every ancestor is
 * already baked in. From the 4 corners + the SVG's viewBox we solve a
 * 2D affine matrix M that maps:
 *
 *     (vbX, vbY)         → TL_screen
 *     (vbX + vbW, vbY)   → TR_screen
 *     (vbX, vbY + vbH)   → BL_screen
 *
 * That's 6 equations / 6 unknowns (a, b, c, d, e, f). Closed-form:
 *   a = (TR.x - TL.x) / vbW    c = (BL.x - TL.x) / vbH
 *   b = (TR.y - TL.y) / vbW    d = (BL.y - TL.y) / vbH
 *   e = TL.x - a·vbX - c·vbY
 *   f = TL.y - b·vbX - d·vbY
 *
 * Fallback: `getScreenCTM` (only reliably includes the SVG's `transform`
 * attribute — misses CSS `rotate: 72deg` etc. in some browsers).
 *
 * NOTE: this returns the WRAPPER's viewBox→screen matrix only. Rotation of
 * an SVG shape now lives as a `transform` ATTRIBUTE on the inner shape,
 * not a CSS transform on the wrapper — `getActiveSvgFullCTM()` (below)
 * composes that on top.
 */
function getWrapperViewBoxCTM(svgArg: SVGSVGElement | null = activeSvg): DOMMatrix | null {
  // `svgArg` defaults to the active shape-edit target; selection-overlay
  // corner math passes an explicit element (any SVG shape wrapper, not just
  // the one being edited). Shadow `activeSvg` with the resolved element so
  // the rest of the body is unchanged.
  const activeSvg = svgArg;
  if (!activeSvg) return null;

  // UNIFIED PATH — delegate to the single deterministic ancestor-chain matrix
  // (svg-user-to-screen.ts). It composes a rotated GROUP ancestor's CSS
  // rotation into the child's CTM, which the old Method-0 (nested-in-group)
  // path DROPPED — that's why shape-edit anchor circles were offset when the
  // parent group was rotated. Methods 0–3 below remain ONLY as a fallback if
  // the composer can't read the geometry (detached element, etc.).
  const unified = getSvgWrapperViewBoxAffine(activeSvg, svgCtmContext());
  if (unified) return affineToDOMMatrix(unified);

  // Read viewBox.
  let vbX = 0, vbY = 0, vbW = 0, vbH = 0;
  const vbAttr = activeSvg.getAttribute('viewBox');
  if (vbAttr) {
    const parts = vbAttr.split(/[\s,]+/).map(Number);
    vbX = parts[0] || 0; vbY = parts[1] || 0; vbW = parts[2] || 0; vbH = parts[3] || 0;
  }
  if (!vbW || !vbH) {
    vbW = parseFloat(activeSvg.style.width || '0') || 100;
    vbH = parseFloat(activeSvg.style.height || '0') || 100;
  }

  // Method 0: nested-in-group SVG. A group child is a `<svg>` nested inside
  // a parent `<svg>`, positioned by `x`/`y`/`width`/`height` ATTRIBUTES — it
  // has NO inline CSS `left/top/width/height`. Both later methods break for
  // it: `getBoxQuads` reports empty/degenerate quads for nested SVGs in some
  // browsers, and the Method 2 reconstruction reads `activeSvg.style.*`
  // (all empty here) → it would place the overlay at the canvas origin at
  // the wrong scale, so the anchor circles render nowhere near the painted
  // shape. `getActiveSvgScreenRect()` already computes the correct screen
  // border box for this case (parent's screen rect + the nested SVG's
  // positioning attrs scaled by the parent's viewBox→viewport ratio); build
  // the affine matrix from that rect's corners + the nested SVG's own
  // viewBox. Must run BEFORE getBoxQuads — the manual formula is the only
  // path that matches nested-SVG painted geometry deterministically.
  const wrapperParent = activeSvg.parentNode as Element | null;
  if (wrapperParent && wrapperParent.tagName && wrapperParent.tagName.toLowerCase() === 'svg') {
    const r = getActiveSvgScreenRect(activeSvg);
    if (r.width > 0 && r.height > 0) {
      const coeffs = solveViewBoxAffine(
        { x: r.left, y: r.top },
        { x: r.left + r.width, y: r.top },
        { x: r.left, y: r.top + r.height },
        { x: vbX, y: vbY, width: vbW, height: vbH },
      );
      if (coeffs) {
        trace.fn('shape-edit-host.getWrapperViewBoxCTM:nested-in-group', {
          nodeId: activeNodeId, rect: r, vbX, vbY, vbW, vbH,
        });
        return new DOMMatrix(coeffs);
      }
    }
  }

  // Method 1: getBoxQuads — solve the viewBox→screen affine matrix from the
  // SVG wrapper's ACTUAL rendered border-box corners.
  //
  // Why this is the primary path for top-level SVGs (was previously a
  // fallback): it reads the real painted geometry, so it's correct no
  // matter WHERE the wrapper's size/position came from — inline style, a
  // CSS class, a parent flex layout, or (critically) an injected
  // `@container` responsive override. The old "manual composition" path
  // reconstructed the box from `activeSvg.style.left/top/width/height` (the
  // INLINE styles only). The sandbox renderer applies a node's BASE styles
  // inline but applies per-breakpoint overrides via injected `@container`
  // CSS rules — so on any non-primary viewport the inline width is the base
  // value, not the rendered one, and the overlay ended up offset /
  // mis-scaled. getBoxQuads sidesteps that entirely, and also bakes in
  // every CSS transform in the ancestor chain (canvas pan/zoom, wrapper
  // rotate) for free.
  const quadFn = (activeSvg as unknown as { getBoxQuads?: (opts?: { box: 'border' | 'padding' | 'content' }) => DOMQuad[] }).getBoxQuads;
  if (typeof quadFn === 'function') {
    try {
      const quads = quadFn.call(activeSvg, { box: 'border' });
      if (quads && quads.length > 0) {
        const q = quads[0];
        const coeffs = solveViewBoxAffine(
          { x: q.p1.x, y: q.p1.y },
          { x: q.p2.x, y: q.p2.y },
          { x: q.p4.x, y: q.p4.y },
          { x: vbX, y: vbY, width: vbW, height: vbH },
        );
        // null = degenerate quad (0×0 box). Nested SVGs inside a group can
        // report empty quads in some browsers; fall through to the
        // reconstruction path for those.
        if (coeffs) return new DOMMatrix(coeffs);
      }
    } catch { /* fall through */ }
  }

  // Method 2: manual composition — fallback for when getBoxQuads is
  // unavailable or degenerate (nested-in-group SVGs). Reconstructs the box
  // from `activeSvg.style.left/top/width/height` + the canvas scale. NOTE:
  // this reads INLINE styles, so it's only accurate on the primary
  // breakpoint (where inline == rendered) — kept solely as a last resort
  // before getScreenCTM.
  //   - CSS box dimensions from `activeSvg.style.left/top/width/height`
  //   - Canvas scale from the content-root's computed CSS transform
  //     (parsed via DOMMatrix). This is the canonical canvas-level scale
  //     and avoids the `offsetParent.offsetWidth` fallback which returned
  //     0 or wrong values in some setups (ovaling the anchor handles).
  //   - SVG's own CSS transform via `getComputedStyle(svg).transform` —
  //     this normalizes individual `rotate` / `scale` / `translate`
  //     properties AND the `transform` property into one matrix string.
  try {
    // Find content-root (canvas pan/zoom container) to extract scale.
    const contentRoot = activeSvg.closest('[data-content-root]') as HTMLElement | null;
    let canvasScale = 1;
    let canvasTx = 0, canvasTy = 0;
    if (contentRoot) {
      const crT = getComputedStyle(contentRoot).transform;
      if (crT && crT !== 'none') {
        try {
          const crM = new DOMMatrix(crT);
          // Uniform scale assumption (canvas pan/zoom is always uniform).
          canvasScale = Math.sqrt(crM.a * crM.a + crM.b * crM.b) || 1;
          // We also need the content-root's screen position (its translate
          // component, baked into the matrix). Read its bounding rect for
          // a definitive answer that accounts for the full ancestor chain
          // (iframe positioning included).
          const crRect = contentRoot.getBoundingClientRect();
          canvasTx = crRect.left;
          canvasTy = crRect.top;
        } catch { /* fall through */ }
      } else {
        const crRect = contentRoot.getBoundingClientRect();
        canvasTx = crRect.left;
        canvasTy = crRect.top;
      }
    }
    const cssLeft = parseFloat(activeSvg.style.left || '0') || 0;
    const cssTop  = parseFloat(activeSvg.style.top  || '0') || 0;
    const cssW    = parseFloat(activeSvg.style.width  || '0') || vbW;
    const cssH    = parseFloat(activeSvg.style.height || '0') || vbH;
    // SVG's CSS box on screen, pre-CSS-transform.
    const boxL = canvasTx + cssLeft * canvasScale;
    const boxT = canvasTy + cssTop  * canvasScale;
    const boxW = cssW * canvasScale;
    const boxH = cssH * canvasScale;
    // SVG's own CSS transform (rotate / scale / translate, individual or
    // composed via `transform`). getComputedStyle always returns matrix(...)
    // regardless of source property.
    const tStr = getComputedStyle(activeSvg).transform;
    const cssMRaw = (tStr && tStr !== 'none')
      ? new DOMMatrix(tStr)
      : new DOMMatrix();
    // `cssMRaw`'s TRANSLATION (e/f) is authored in the element's LOCAL
    // (canvas) units — but Method 2 composes it in SCREEN space (cx/cy
    // below are screen coords), so the translation must be lifted to
    // screen px by the canvas zoom. Rotation/scale components (a/b/c/d)
    // are zoom-invariant — only e/f need scaling. Without this, a live
    // drag `transform: translate(dx,dy)` shifted the overlay by canvas-px
    // instead of screen-px, so the drag outline raced ahead of the shape
    // at any zoom ≠ 100% (correct only at 100%).
    const cssM = new DOMMatrix([
      cssMRaw.a, cssMRaw.b, cssMRaw.c, cssMRaw.d,
      cssMRaw.e * canvasScale, cssMRaw.f * canvasScale,
    ]);
    trace.fn('shape-edit-host.getWrapperViewBoxCTM:method2', {
      nodeId: activeNodeId, canvasScale, cssTx: cssMRaw.e, cssTy: cssMRaw.f,
    });
    // CSS transform-origin default is 50% 50% — the CSS box center.
    const cx = boxL + boxW / 2;
    const cy = boxT + boxH / 2;
    const M = new DOMMatrix()
      .translate(cx, cy)
      .multiply(cssM)
      .translate(-cx, -cy)
      .translate(boxL, boxT)
      .scale(boxW / vbW, boxH / vbH)
      .translate(-vbX, -vbY);
    return M;
  } catch { /* fall through */ }

  // Method 3: native getScreenCTM (least reliable for CSS individual transforms).
  try {
    return activeSvg.getScreenCTM();
  } catch {
    return null;
  }
}

/**
 * The inner shape's own `transform` attribute as a matrix, in the wrapper's
 * viewBox user space. SVG shape rotation is stored as
 * `transform="rotate(angle cx cy)"` on the inner shape (path/polygon/…).
 *
 * Reads the `transform` ATTRIBUTE via the SVG transform list — NOT
 * `getCTM()`. `getCTM()` folds in the wrapper's viewBox-ORIGIN translate:
 * verified in Chromium, for `viewBox="-192 -106 817 817"` the path's
 * `getCTM()` reports `e/f` offset by exactly `(192, 106)` vs the bare
 * `transform`. `getActiveSvgFullCTM()` composes this on top of
 * `getWrapperViewBoxCTM()`, which ALREADY maps the viewBox — so using
 * `getCTM()` here double-applies the viewBox origin and throws the anchor
 * overlay off by `viewBoxScale × viewBoxOrigin` px. That's invisible for
 * freshly-drawn "0 0 W H" shapes (origin 0,0 → no offset) and only
 * surfaces AFTER a reshape, when `computeNormalizedBounds` re-fits the
 * viewBox to a non-zero / negative origin.
 *
 * `transform.baseVal` reflects ONLY the element's own `transform`
 * attribute, in viewBox user space, and — unlike
 * `transform.baseVal.consolidate()` — does not mutate the live attribute.
 * Returns null when there's no shape child or no transform; composing
 * identity would be a no-op anyway, so callers treat null as "no inner
 * transform".
 */
export function getInnerShapeTransformMatrix(svgArg: SVGSVGElement | null = activeSvg): DOMMatrix | null {
  if (!svgArg) return null;
  // First shape child only — matches the childIndex:0 target that
  // RotateManager / RotateControl write the rotation attribute to.
  const child = firstSvgShapeChild(svgArg);
  if (!child) return null;
  try {
    const list = child.transform?.baseVal;
    if (!list || list.numberOfItems === 0) return null;
    let m = new DOMMatrix();
    for (let i = 0; i < list.numberOfItems; i++) {
      const item = list.getItem(i);
      if (item && item.matrix) m = m.multiply(DOMMatrix.fromMatrix(item.matrix));
    }
    return m;
  } catch {
    return null;
  }
}

/**
 * Full user-space → screen matrix for the path geometry the editor edits:
 * the wrapper's viewBox→screen CTM composed with the inner shape's own
 * `transform` attribute. Every consumer (the `getScreenCTM` adapter, the
 * overlay-geometry RAF, `getSvgRect`) goes through here, so rotation stored
 * on the inner shape flows into the overlay the same way wrapper CSS
 * rotation used to.
 */
function getActiveSvgFullCTM(svgArg: SVGSVGElement | null = activeSvg): DOMMatrix | null {
  const wrapperCTM = getWrapperViewBoxCTM(svgArg);
  if (!wrapperCTM) return null;
  const innerM = getInnerShapeTransformMatrix(svgArg);
  // wrapperCTM · innerM — innerM applied first (path-local → viewBox →
  // screen). A pure rotation leaves the CTM's scale magnitudes unchanged,
  // so `getSvgRect`'s box-size math stays correct.
  return innerM ? wrapperCTM.multiply(innerM) : wrapperCTM;
}

/**
 * The 4 rotated screen-space corners of an SVG shape wrapper's painted
 * geometry: the wrapper's viewBox→screen CTM composed with the inner
 * shape's own `transform` attribute, applied to the inner shape's
 * UN-ROTATED bounding box (`getBBox` ignores the element's own transform).
 *
 * This is the selection-overlay counterpart to the shape-edit overlay's
 * geometry — both must rotate with a shape whose rotation lives as a
 * `transform` ATTRIBUTE on the inner shape (path/polygon/…) rather than a
 * CSS transform on the `<svg>` wrapper.
 * Reuses the exact CTM pipeline the shape-edit overlay uses, so it's
 * correct for a top-level `<svg>` AND a nested-in-group `<svg>` (the
 * `getWrapperViewBoxCTM` Method 0 path handles the nested case).
 *
 * Legacy CSS-rotated wrappers also flow through here: `getWrapperViewBoxCTM`'s
 * getBoxQuads path bakes the wrapper's CSS transform into the CTM and
 * `getInnerShapeTransformMatrix` returns null, so the un-rotated geometry
 * bbox still maps to correctly-rotated screen corners.
 *
 * Returns null when there's no geometry child or its bbox is degenerate —
 * the caller falls back to the axis-aligned painted rect.
 */
export function getSvgShapeScreenCorners(svg: SVGSVGElement): {
  TL: { x: number; y: number }; TR: { x: number; y: number };
  BR: { x: number; y: number }; BL: { x: number; y: number };
} | null {
  const ctm = getActiveSvgFullCTM(svg);
  if (!ctm) return null;
  const child = firstSvgShapeChild(svg);
  if (!child || typeof child.getBBox !== 'function') return null;
  let bbox: DOMRect;
  try {
    bbox = child.getBBox();
  } catch {
    return null;
  }
  if (!(bbox.width > 0) || !(bbox.height > 0)) return null;
  const x0 = bbox.x, y0 = bbox.y, x1 = bbox.x + bbox.width, y1 = bbox.y + bbox.height;
  const tl = new DOMPoint(x0, y0).matrixTransform(ctm);
  const tr = new DOMPoint(x1, y0).matrixTransform(ctm);
  const br = new DOMPoint(x1, y1).matrixTransform(ctm);
  const bl = new DOMPoint(x0, y1).matrixTransform(ctm);
  return {
    TL: { x: tl.x, y: tl.y },
    TR: { x: tr.x, y: tr.y },
    BR: { x: br.x, y: br.y },
    BL: { x: bl.x, y: bl.y },
  };
}

function getActiveSvgScreenRect(svgArg: SVGSVGElement | null = activeSvg): { left: number; top: number; width: number; height: number } {
  const activeSvg = svgArg;
  if (!activeSvg) return { left: 0, top: 0, width: 100, height: 100 };
  const parent = activeSvg.parentNode as Element | null;
  if (parent && parent.tagName.toLowerCase() === 'svg') {
    // Nested SVG inside a group SVG. Compute the screen rect manually
    // from the parent's screen rect + the nested SVG's positioning attrs
    // + the parent's viewBox→viewport scale. `getBoundingClientRect()`
    // and `getScreenCTM()` both behave inconsistently for nested SVGs
    // with `preserveAspectRatio="none"` — the manual formula is the only
    // path that matches the actual painted geometry deterministically.
    const parentSvg = parent as SVGSVGElement;
    const parentRect = parentSvg.getBoundingClientRect();
    const parentVbAttr = parentSvg.getAttribute('viewBox');
    const pParts = parentVbAttr ? parentVbAttr.split(/[\s,]+/).map(Number) : [0, 0, parentRect.width, parentRect.height];
    // The nested SVG's `x`/`y` ATTRIBUTES are the committed (source)
    // position. During a live drag the strategy moves the child via a CSS
    // `transform: translate(...)` on the wrapper (compositor-only — no
    // source/attr write until mouseup), so the attrs stay stale and the
    // selection overlay would FREEZE at the pre-drag spot. Read the live
    // computed transform's translation and fold it into x/y. A CSS
    // `translate()` on a nested `<svg>` shifts it in the parent's viewBox
    // user space — the same space x/y live in — so it adds directly.
    let tx = 0, ty = 0;
    try {
      const t = getComputedStyle(activeSvg).transform;
      if (t && t !== 'none') {
        const m = new DOMMatrix(t);
        tx = m.e;
        ty = m.f;
      }
    } catch { /* no live transform — attrs are the position */ }
    return nestedSvgScreenRect(
      { left: parentRect.left, top: parentRect.top, width: parentRect.width, height: parentRect.height },
      {
        x: Number.isFinite(pParts[0]) ? pParts[0] : 0,
        y: Number.isFinite(pParts[1]) ? pParts[1] : 0,
        width: pParts[2] || 0,
        height: pParts[3] || 0,
      },
      {
        x: (parseFloat(activeSvg.getAttribute('x') || '0') || 0) + tx,
        y: (parseFloat(activeSvg.getAttribute('y') || '0') || 0) + ty,
        width: parseFloat(activeSvg.getAttribute('width') || '0') || 0,
        height: parseFloat(activeSvg.getAttribute('height') || '0') || 0,
      },
    );
  }
  // Top-level SVG (positioned via CSS style left/top/width/height) —
  // getBoundingClientRect works correctly here.
  const r = activeSvg.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function svgElementToMarkup(svg: SVGSVGElement): string {
  const wrapperW = parseFloat((svg.style.width || svg.getAttribute('width') || '0')) || 100;
  const wrapperH = parseFloat((svg.style.height || svg.getAttribute('height') || '0')) || 100;
  const viewBoxAttr = svg.getAttribute('viewBox') || `0 0 ${Math.round(wrapperW)} ${Math.round(wrapperH)}`;
  const par = svg.getAttribute('preserveAspectRatio') || 'none';
  // Only the children matter for the library — it treats the wrapper as
  // a coordinate frame, not part of the path. Serialize each child as
  // self-closing kebab-case XML (the library's parser accepts both XML
  // and HTML namespacing because it normalizes via DOMParser internally).
  const childMarkup: string[] = [];
  for (const child of Array.from(svg.children)) {
    childMarkup.push(serializeShape(child as SVGElement));
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBoxAttr}" preserveAspectRatio="${par}" width="${Math.round(wrapperW)}" height="${Math.round(wrapperH)}">${childMarkup.join('')}</svg>`;
}

function serializeShape(el: SVGElement): string {
  const tag = el.tagName.toLowerCase();
  const attrs: string[] = [];
  for (const a of Array.from(el.attributes)) {
    if (a.name.startsWith('data-')) continue;
    attrs.push(`${a.name}="${escapeXml(a.value)}"`);
  }
  return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''} />`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Remove renderer-stamped artifacts that should never round-trip into source.
 *  - `data-node-id` / `data-id`: the renderer assigns these fresh from the
 *    parser's auto-counter on every render. Baking them into source causes
 *    cross-SVG id collisions and DOM element lookup misses (see
 *    commitShapeEdit comment).
 *  - The `<defs data-rev-defs="1">…</defs>` block the renderer injects to
 *    host stroke-alignment `<clipPath>` defs (Inside mode, see
 *    `applyStrokeAlignment` in Renderer.ts). It's runtime-only; the renderer
 *    rebuilds it from `data-stroke-align` on every render.
 *  - `clip-path="url(#rev-stroke-clip-…)"` attribute the renderer adds to
 *    shapes pointing at those defs. Same rationale — runtime-only.
 *  - inline `style` declarations the renderer used to paint (legacy v1 path):
 *    `clip-path`, `-webkit-clip-path`, `paint-order`. New code routes these
 *    through CSS rules / SVG attrs instead, but cleanup is kept so existing
 *    polluted source self-heals on the next shape-edit. */
function stripRendererArtifacts(markup: string): string {
  return markup
    // Drop the entire renderer-injected defs block (and everything inside it).
    .replace(/<defs\b[^>]*\bdata-rev-defs="1"[^>]*>[\s\S]*?<\/defs>/gi, '')
    // Drop self-closing variant just in case.
    .replace(/<defs\b[^>]*\bdata-rev-defs="1"[^>]*\/>/gi, '')
    .replace(/\s+data-node-id="[^"]*"/g, '')
    .replace(/\s+data-id="[^"]*"/g, '')
    .replace(/\s+clip-path="url\(#rev-stroke-clip-[^"]*"\)/g, '')
    // Tolerant variant (in case quoting differs).
    .replace(/\s+clip-path="url\(#rev-stroke-clip-[^)]*\)"/g, '')
    .replace(/\s+style="[^"]*"/g, (m) => {
      const inner = m.slice(8, -1); // strip ` style="' ... '"'
      const cleaned = inner
        .split(';')
        .map(d => d.trim())
        .filter(d => d && !/^(-webkit-)?clip-path\s*:/i.test(d) && !/^paint-order\s*:/i.test(d))
        .join('; ');
      return cleaned ? ` style="${cleaned}"` : '';
    });
}

// Per-tile geometry: each drawable shape's `d`, addressed by a deterministic id
// that index-aligns with `ensureShapeChildIds` (source) so a per-tile `d` override
// routes to the right path node. polygons/polylines fold to a path `d`.
const GEOMETRY_SELECTOR = 'path, polygon, polyline';
function geometryElementToD(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (tag === 'path') return el.getAttribute('d') || '';
  const pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).filter(Boolean);
  if (pts.length < 4) return '';
  let d = `M${pts[0]},${pts[1]}`;
  for (let i = 2; i + 1 < pts.length; i += 2) d += ` L${pts[i]},${pts[i + 1]}`;
  return tag === 'polygon' ? d + ' Z' : d;
}
function extractShapeGeometry(svg: Element, wrapperId: string): { dataId: string; d: string }[] {
  return Array.from(svg.querySelectorAll(GEOMETRY_SELECTOR))
    .map((el, i) => ({ dataId: `${wrapperId}-g${i}`, d: geometryElementToD(el) }))
    .filter(s => s.d);
}

/** Pull just the inner JSX (between `<svg ...>` and `</svg>`) out of full markup. */
function extractInnerSvg(fullSvg: string): string {
  const openEnd = fullSvg.indexOf('>');
  const closeStart = fullSvg.lastIndexOf('</svg>');
  if (openEnd === -1 || closeStart === -1 || closeStart < openEnd) return '';
  return fullSvg.slice(openEnd + 1, closeStart).trim();
}

/** Compute the painted bbox of the SVG in user-space (viewBox) coords —
 *  the same `getBBox()` value the parent-frame normalize used to query
 *  via Comlink. Synchronous now that we live in the iframe. */
function getPaintedBBox(svg: SVGSVGElement): { x: number; y: number; width: number; height: number } | null {
  if (typeof svg.getBBox !== 'function') return null;
  try {
    const b = svg.getBBox();
    if (!Number.isFinite(b.width) || !Number.isFinite(b.height)) return null;
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  } catch {
    return null;
  }
}

/** Live re-centre of a STANDALONE flex shape DURING a vertex drag. The morph
 *  changes the painted bounds, so the content drifts off-centre in its flex
 *  slot. We can't re-fit its box+viewBox mid-drag (that would desync the editor
 *  library's anchor viewBox, which needs a reload). Instead keep box+viewBox
 *  FIXED (anchors stay valid; the overlay RAF re-glues to the moved element) and
 *  only shift left/top so the painted content's centre lands on the box's
 *  flow-centre — the oversized box is clipped by the frame so it reads as
 *  centred. The real box-fit (+ left/top clear) happens on vertex release /
 *  commit via `computeNormalizedBounds`. Flex/flow shapes only. */
function liveRecenterStandaloneFlexShape(svg: SVGSVGElement): void {
  if (svg.style.position === 'absolute' || svg.style.position === 'fixed') return;
  const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const vbX = vb[0] || 0, vbY = vb[1] || 0, vbW = vb[2] || 0, vbH = vb[3] || 0;
  const W = parseFloat(svg.style.width || '0') || 0;
  const H = parseFloat(svg.style.height || '0') || 0;
  if (!(vbW > 0) || !(vbH > 0) || !(W > 0) || !(H > 0)) return;
  const bbox = getPaintedBBox(svg);
  if (!bbox || bbox.width <= 0 || bbox.height <= 0) return;
  const scaleX = W / vbW, scaleY = H / vbH;
  // Painted content centre in box px, then shift the box so it lands on box centre.
  const cxPx = (bbox.x + bbox.width / 2 - vbX) * scaleX;
  const cyPx = (bbox.y + bbox.height / 2 - vbY) * scaleY;
  svg.style.left = `${r3(W / 2 - cxPx)}px`;
  svg.style.top = `${r3(H / 2 - cyPx)}px`;
}

/** Compute normalized wrapper bounds for the SVG so the next CSS box
 *  fits the painted geometry. Returns null when the bounds already fit
 *  (within 0.5 px) — caller should skip the source mutation. Integer-only
 *  user-space coords keep `wrapperW / vbW === 1` indefinitely; floating-
 *  point viewBox values combined with `Math.round`-ed widths drift. */
function computeNormalizedBounds(svg: SVGSVGElement): {
  viewBox: string; widthPx: string; heightPx: string; leftPx: string; topPx: string;
} | null {
  const wrapperW = parseFloat(svg.style.width || '0');
  const wrapperH = parseFloat(svg.style.height || '0');
  const wrapperL = parseFloat(svg.style.left || '0');
  const wrapperT = parseFloat(svg.style.top || '0');
  const vbStr = svg.getAttribute('viewBox') || `0 0 ${Math.round(wrapperW)} ${Math.round(wrapperH)}`;
  const [vbX, vbY, vbW, vbH] = vbStr.split(/[\s,]+/).map(Number);
  if (!Number.isFinite(vbW) || !Number.isFinite(vbH) || vbW <= 0 || vbH <= 0) return null;
  if (!(wrapperW > 0) || !(wrapperH > 0)) return null;
  const scaleX = wrapperW / vbW;
  const scaleY = wrapperH / vbH;
  // Sanity check — see SvgEditorOverlay history.
  const scaleRatio = scaleX > scaleY ? scaleX / scaleY : scaleY / scaleX;
  if (!Number.isFinite(scaleRatio) || scaleRatio > 5) return null;

  const bbox = getPaintedBBox(svg);
  if (!bbox || bbox.width <= 0 || bbox.height <= 0) return null;
  const bx = Math.round(bbox.x);
  const by = Math.round(bbox.y);
  const bw = Math.round(bbox.width);
  const bh = Math.round(bbox.height);
  const offsetXpx = (bx - vbX) * scaleX;
  const offsetYpx = (by - vbY) * scaleY;
  const newWidth = bw * scaleX;
  const newHeight = bh * scaleY;
  // A FLEX/FLOW shape (position ≠ absolute) is positioned by its parent layout,
  // NOT by left/top. The normal `wrapperL + offset` compensation keeps an
  // ABSOLUTE shape's painted content fixed, but on a flex child it OFFSETS it
  // out of its (e.g. centered) flow slot — the shape drifts off-centre on every
  // reshape. For a flex shape CLEAR left/top so the box just resizes to its
  // content and the layout re-centres it.
  const isFlexChild = svg.style.position !== 'absolute' && svg.style.position !== 'fixed';
  const hasLeftTop = !!svg.style.left || !!svg.style.top;
  const tol = 0.5;
  if (
    Math.abs(offsetXpx) < tol && Math.abs(offsetYpx) < tol &&
    Math.abs(newWidth - wrapperW) < tol && Math.abs(newHeight - wrapperH) < tol &&
    // A flex shape that already fits but still carries a stale left/top must NOT
    // be skipped — it needs the clear below to re-centre.
    !(isFlexChild && hasLeftTop)
  ) {
    return null; // already fits — skip
  }
  return {
    viewBox: `${bx} ${by} ${bw} ${bh}`,
    widthPx: `${Math.round(newWidth)}px`,
    heightPx: `${Math.round(newHeight)}px`,
    leftPx: isFlexChild ? '' : `${Math.round(wrapperL + offsetXpx)}px`,
    topPx: isFlexChild ? '' : `${Math.round(wrapperT + offsetYpx)}px`,
  };
}

/** Apply normalized wrapper bounds directly to the iframe SVG element.
 *  All in one synchronous tick → browser paints once, no jump. */
function applyBoundsToWrapper(svg: SVGSVGElement, bounds: {
  viewBox: string; widthPx: string; heightPx: string; leftPx: string; topPx: string;
}): void {
  svg.setAttribute('viewBox', bounds.viewBox);
  svg.style.width = bounds.widthPx;
  svg.style.height = bounds.heightPx;
  svg.style.left = bounds.leftPx;
  svg.style.top = bounds.topPx;
}

/** Edit-mode CSS: ensures the SVG stays selectable and isn't clipped. */
function injectEditStyles(): void {
  if (!editStyleEl) {
    editStyleEl = document.createElement('style');
    editStyleEl.setAttribute('data-shape-edit-style', 'true');
    document.head.appendChild(editStyleEl);
  }
  editStyleEl.textContent = `
    /* Hide canvas-dnd's hover/select overlays during shape edit. */
    #dnd-overlay { display: none !important; }
    /* Force overflow:visible so anchors past the wrapper paint correctly. */
    [data-shape-editing] { overflow: visible !important; }
  `;
}

function removeEditStyles(): void {
  if (editStyleEl) {
    editStyleEl.remove();
    editStyleEl = null;
  }
}

// ─── Public API (called by bridge-sandbox.ts) ────────────────────────────

export function startShapeEdit(nodeId: string, vpPrefix: string, pen: boolean = false): void {
  // Internal double-start guard: tear down the previous editor without
  // emitting `shapeEditCancelled`. Calling `cancelShapeEdit()` here was
  // a bug — it emits the user-cancelled signal, which the parent
  // interprets as "user clicked outside, exit shape-edit", clearing
  // `shapeEditingIdAtom` and unmounting the overlay we're trying to
  // start. Pattern hits in two cases: React StrictMode's intentional
  // double-mount of SvgEditorOverlay, AND multi-viewport pages where
  // each viewport's SvgEditorOverlay calls bridge.startShapeEdit on the
  // same nodeId. Both should silently re-init, not signal cancel.
  if (activeEditor) {
    try { activeEditor.detach(); } catch { /* ignore */ }
    cleanup();
  }
  if (!contentRoot) return;

  const el = findElByNodeId(contentRoot, vpPrefix, nodeId);
  if (!el || el.tagName.toLowerCase() !== 'svg') {
    // The node may have JUST been committed by the path tool and not rendered
    // into the iframe yet (the addCanvasNode re-render is async). Retry on the
    // next frames before giving up, so "draw → auto-enter editor" can mount.
    if (_startShapeEditRetries < 10) {
      _startShapeEditRetries++;
      requestAnimationFrame(() => startShapeEdit(nodeId, vpPrefix, pen));
      return;
    }
    _startShapeEditRetries = 0;
    emit({ type: 'error', message: `shape-edit-host: SVG element not found for ${vpPrefix}${nodeId}` });
    return;
  }
  _startShapeEditRetries = 0;
  const svg = el as unknown as SVGSVGElement;

  activeNodeId = nodeId;
  activeVpPrefix = vpPrefix;
  activeSvg = svg;
  isDragging = false;
  pendingInnerJSX = null;

  svg.setAttribute('data-shape-editing', 'true');
  injectEditStyles();

  // Migrate legacy SVGs that were drawn before ShapeCreator emitted
  // `viewBox` + `preserveAspectRatio="none"` — the editor needs both
  // to map screen coords to user-space correctly. Apply imperatively
  // here; the source-level migration happens at commit if the user edits.
  if (!svg.getAttribute('viewBox')) {
    const w = parseFloat(svg.style.width || '0') || 100;
    const h = parseFloat(svg.style.height || '0') || 100;
    svg.setAttribute('viewBox', `0 0 ${Math.round(w)} ${Math.round(h)}`);
  }
  if (!svg.getAttribute('preserveAspectRatio')) {
    svg.setAttribute('preserveAspectRatio', 'none');
  }

  // Bake any per-tile CSS `d` OVERRIDE into the `d` ATTRIBUTE before the editor
  // snapshots geometry. A per-variant / per-viewport shape edit rides the CSS
  // `d` PROPERTY (variants object / `@media`), which the browser paints ON TOP
  // of the shared base `d` attribute. But the editor library + `svgElementToMarkup`
  // read the ATTRIBUTE — so without this they'd seed anchors from the base shape
  // while THIS tile paints the override: the anchors land off the shape, and on
  // first drag (the library's innerHTML replace strips `data-id`, so the
  // `@container`/variant rule stops matching) the shape JUMPS to the base. Reading
  // the COMPUTED `d` collapses base+override into the geometry actually painted on
  // this tile; writing it to the attribute keeps everything downstream
  // (serialize → library → commit's extractShapeGeometry) on that one value.
  for (const child of Array.from(svg.querySelectorAll('path'))) {
    try {
      const cssD = getComputedStyle(child).getPropertyValue('d').trim();
      if (cssD && cssD !== 'none') {
        const m = cssD.match(/^path\(\s*(['"])([\s\S]*?)\1\s*\)$/);
        const raw = (m ? m[2] : cssD).trim();
        if (raw && child.getAttribute('d') !== raw) child.setAttribute('d', raw);
      }
    } catch { /* computed-d unsupported (older browser) → keep base attribute */ }
  }

  // Snapshot initial markup for the library's adapter.
  initialMarkupRef = svgElementToMarkup(svg);
  currentMarkupRef = initialMarkupRef;

  // Library's overlay needs a positioning container. Place it as a
  // SIBLING of the SVG so it can render anchors absolutely-positioned
  // over the SVG's iframe-screen rect without affecting layout.
  // `getActiveSvgScreenRect()` mirrors the adapter's `getSvgRect` —
  // computes the rect manually for nested-in-group SVGs since
  // `getBoundingClientRect()` is unreliable there.
  const wrapperRect = getActiveSvgScreenRect();
  activeOverlayContainer = document.createElement('div');
  activeOverlayContainer.setAttribute('data-shape-edit-overlay', 'true');
  Object.assign(activeOverlayContainer.style, {
    position: 'fixed',
    left: `${wrapperRect.left}px`,
    top: `${wrapperRect.top}px`,
    width: `${wrapperRect.width}px`,
    height: `${wrapperRect.height}px`,
    pointerEvents: 'auto',
    zIndex: '999999',
  });
  document.body.appendChild(activeOverlayContainer);

  // RAF poll keeps the overlay glued to the SVG as the user drags
  // anchors that resize the wrapper (or as canvas pan/zoom / CSS rotate
  // shifts it). The overlay must follow the host SVG through ANY transform
  // chain, not just translation — so we compute the overlay's geometry
  // by decomposing the host SVG's `getScreenCTM()`:
  //
  //   1. CTM = canvas-translate · canvas-scale · css-rotate · viewBox→box
  //   2. (a, b) row of CTM = X-axis basis in screen → magnitude = scaleX, angle = rotation
  //   3. (c, d) row = Y-axis basis → magnitude = scaleY
  //   4. Transform viewBox-center via CTM → screen center
  //   5. UN-ROTATED CSS box on screen = center ± (vbW·scaleX, vbH·scaleY)/2
  //   6. Apply matching CSS rotate(angle) around 50% 50%
  //
  // Result: the overlay container's CSS box matches the host SVG's
  // un-rotated CSS box AND it CSS-rotates by the same angle around the
  // same center. Anchor handles drawn at viewBox positions inside the
  // overlay (linear box-mapping) then CSS-rotate to the exact screen
  // positions the host SVG renders the path verts at.
  //
  // Falls back to `getActiveSvgScreenRect` (AABB) if CTM is unavailable
  // (nested-in-group SVG path, detached element, etc.) — same behavior
  // as before for those cases, no rotation support.
  type OverlayGeom = { left: number; top: number; width: number; height: number; rotateDeg: number };
  const computeOverlayGeom = (): OverlayGeom | null => {
    if (!activeSvg) return null;
    const ctm = getActiveSvgFullCTM();
    if (!ctm) return null;
    // Read viewBox.
    let vbX = 0, vbY = 0, vbW = 0, vbH = 0;
    const vbAttr = activeSvg.getAttribute('viewBox');
    if (vbAttr) {
      const parts = vbAttr.split(/[\s,]+/).map(Number);
      vbX = parts[0] || 0; vbY = parts[1] || 0; vbW = parts[2] || 0; vbH = parts[3] || 0;
    }
    if (!vbW || !vbH) {
      // Fall back to style width/height — same scale as viewBox when no
      // viewBox is set (host SVG uses 1:1 user→css mapping).
      vbW = parseFloat(activeSvg.style.width || '0') || 100;
      vbH = parseFloat(activeSvg.style.height || '0') || 100;
    }
    const a = ctm.a, b = ctm.b, c = ctm.c, d = ctm.d;
    const scaleX = Math.sqrt(a * a + b * b);
    const scaleY = Math.sqrt(c * c + d * d);
    const rotation = Math.atan2(b, a);
    const centerVb = new DOMPoint(vbX + vbW / 2, vbY + vbH / 2);
    const centerScreen = centerVb.matrixTransform(ctm);
    const widthScreen = vbW * scaleX;
    const heightScreen = vbH * scaleY;
    return {
      left: centerScreen.x - widthScreen / 2,
      top: centerScreen.y - heightScreen / 2,
      width: widthScreen,
      height: heightScreen,
      rotateDeg: rotation * (180 / Math.PI),
    };
  };

  let rafId: number | null = null;
  let lastL = wrapperRect.left, lastT = wrapperRect.top;
  let lastW = wrapperRect.width, lastH = wrapperRect.height;
  let lastRot = NaN;
  const tick = () => {
    if (!activeSvg || !activeOverlayContainer) return;
    const geom = computeOverlayGeom();
    if (geom) {
      if (geom.left !== lastL || geom.top !== lastT || geom.width !== lastW || geom.height !== lastH) {
        activeOverlayContainer.style.left = `${geom.left}px`;
        activeOverlayContainer.style.top = `${geom.top}px`;
        activeOverlayContainer.style.width = `${geom.width}px`;
        activeOverlayContainer.style.height = `${geom.height}px`;
        lastL = geom.left; lastT = geom.top; lastW = geom.width; lastH = geom.height;
      }
      if (geom.rotateDeg !== lastRot) {
        activeOverlayContainer.style.transformOrigin = '50% 50%';
        activeOverlayContainer.style.transform = `rotate(${geom.rotateDeg}deg)`;
        lastRot = geom.rotateDeg;
      }
    } else {
      // CTM unavailable — fall back to AABB without rotation.
      const r = getActiveSvgScreenRect();
      if (r.left !== lastL || r.top !== lastT || r.width !== lastW || r.height !== lastH) {
        activeOverlayContainer.style.left = `${r.left}px`;
        activeOverlayContainer.style.top = `${r.top}px`;
        activeOverlayContainer.style.width = `${r.width}px`;
        activeOverlayContainer.style.height = `${r.height}px`;
        lastL = r.left; lastT = r.top; lastW = r.width; lastH = r.height;
      }
      if (lastRot !== 0) {
        activeOverlayContainer.style.transform = '';
        lastRot = 0;
      }
    }
    rafId = requestAnimationFrame(tick);
  };
  // Run once synchronously so the overlay starts at the correct geometry —
  // the RAF schedules the FIRST tick to a future frame, meaning without
  // this prime call there'd be one paint where the overlay is at the
  // initial `wrapperRect` (AABB) and dots appear at AABB-relative positions
  // for one frame before the proper geometry lands.
  tick();
  (activeOverlayContainer as any).__rafId = rafId;

  // Track drag start/end to switch between live (DOM-only) and committed
  // updates. Identical pattern to the parent-frame overlay we replaced.
  const onContainerPointerDown = () => {
    isDragging = true;
    pendingInnerJSX = null;
  };
  const onWindowPointerUp = () => {
    if (!isDragging) return;
    isDragging = false;
    // Pen-CREATION: keep the seed wrapper viewport-sized so the user can keep
    // drawing across the canvas after editing a vertex. The editor already
    // updated its model + viewBox is unchanged (no realign needed); the shrink to
    // the drawn bbox happens once on commit. Without this, the first vertex drag
    // shrank the wrapper → the next draw-click landed outside it → shape exited.
    if (activePenMode) return;
    // If the drag produced a setSvgContent, the iframe SVG already has
    // the new geometry. Compute normalized bounds from the live element
    // and apply them imperatively in the SAME tick so the user sees no
    // jump on release.
    if (pendingInnerJSX !== null && activeSvg) {
      // Skip wrapper-normalize when the host SVG has a non-identity CSS
      // transform (typically rotate). Normalize translates the wrapper to
      // tightly fit the new bbox AND changes its width/height ratio if the
      // bbox aspect differs from the old wrapper. Under rotation:
      //   • The translate pivots the rotation around a NEW center → the
      //     painted shape visibly JUMPS to a new screen position on mouseup.
      //   • The aspect change ovals the overlay's anchor handles (their
      //     viewBox→box mapping uses preserveAspectRatio="none" and stretches
      //     asymmetrically when boxW/boxH ratio diverges from vbW/vbH).
      // Leaving the wrapper alone keeps the shape pinned to where the user
      // dragged it AND keeps the overlay aspect ratio stable. The viewBox
      // may end up with empty padding around the new path bbox, but with
      // `overflow: visible` on the wrapper that's invisible.
      const cssTransform = activeSvg.style.transform || getComputedStyle(activeSvg).transform;
      const hasCssTransform = !!cssTransform && cssTransform !== 'none' && cssTransform.trim() !== '';
      const bounds = hasCssTransform ? null : computeNormalizedBounds(activeSvg);
      if (bounds) {
        applyBoundsToWrapper(activeSvg, bounds);
        // After the wrapper re-normalizes on vertex release, re-fit the parent
        // flex group to the new bounds too (matches the live morph refit above).
        const relParent = activeSvg.parentNode as Element | null;
        if (relParent && relParent.tagName && relParent.tagName.toLowerCase() === 'svg') {
          liveRefitGroupChainEl(relParent as SVGSVGElement);
        }
        // Tell the library its `this.doc.viewBox` is stale. `reload()`
        // re-reads from `getSvgContent` (which serializes fresh from
        // the live SVG, picking up the new viewBox) and re-renders
        // anchors against it — so the anchor handles immediately move
        // to the correct vertices in the new coord space. Without this,
        // anchors stay anchored to the OLD viewBox while the painted
        // path is in the NEW one, and they visibly detach from the
        // shape after every reshape.
        //
        // `reload()` resets the library's internal selection to empty
        // (so it can re-emit anchor positions against the new viewBox).
        // Capture the user's selected anchor BEFORE reload and restore
        // it AFTER — otherwise dragging a bezier handle that extends
        // the path bbox would instantly drop the selection on mouseup,
        // collapsing the Path tool and forcing the user to re-click
        // the anchor to keep editing.
        if (activeEditor) {
          const priorSel = activeEditor.currentSelection;
          const restoreTarget = priorSel.anchorRefs.length === 1
            ? { shapeIndex: priorSel.anchorRefs[0].shapeIndex, anchorIndex: priorSel.anchorRefs[0].anchorIndex }
            : null;
          // Snapshot handleMode of the selected anchor BEFORE reload.
          // `reload()` re-parses the path and re-derives handleMode from
          // command geometry (curves vs lines) — so a user who explicitly
          // set Mirrored on an anchor that's still attached to linear
          // segments would see the Curve toggle silently snap back to
          // Straight after a drag. Restore it post-reload.
          let priorHandleMode: 'straight' | 'mirrored' | 'disconnected' | null = null;
          if (restoreTarget) {
            const a = activeEditor.shapes[restoreTarget.shapeIndex]?.path.anchors[restoreTarget.anchorIndex];
            if (a) priorHandleMode = a.handleMode;
          }
          try { activeEditor.reload(); } catch (err) { trace.error('shape-edit-host:reload-failed', String(err)); }
          if (restoreTarget) {
            try { activeEditor.selectAnchor(restoreTarget); } catch (err) { trace.error('shape-edit-host:reselect-failed', String(err)); }
            if (priorHandleMode && priorHandleMode !== 'straight') {
              try { activeEditor.setHandleMode(priorHandleMode); } catch (err) { trace.error('shape-edit-host:rehandlemode-failed', String(err)); }
            }
          }
        }
      }
    }
  };
  activeOverlayContainer.addEventListener('pointerdown', onContainerPointerDown);
  window.addEventListener('pointerup', onWindowPointerUp);

  // Outside-click handler — committed at capture phase so we exit before
  // the click reaches the canvas's own selection logic. Mirrors the
  // text-edit-host pattern. Without this, on icon-set master files
  // (where vectors cover most of the visible canvas) the user has no
  // empty area to click and no escape path other than Escape key.
  //
  // CRITICAL: do NOT call cleanup() here. The parent's onShapeEditCancelled
  // clears `shapeEditingIdAtom`, which unmounts SvgEditorOverlay, which
  // calls `bridge.commitShapeEdit()` to pull the final wrapper bounds +
  // inner JSX and queue source mutations. If cleanup runs first, activeEditor
  // is null when commitShapeEdit fires → returns null → no mutations queued
  // → source never reflects the edit → selection rect stays at the pre-edit
  // bounds even though the iframe DOM was updated by applyBoundsToWrapper.
  // (commitShapeEdit() runs cleanup itself at the end.)
  let outsideEmitted = false;
  const onDocumentMouseDownCapture = (e: MouseEvent) => {
    if (outsideEmitted) return; // idempotent until the parent unmount cleans us up
    const target = e.target as Node | null;
    if (!target) return;
    // Inside the editor overlay -> stay editing (anchor drags etc).
    if (activeOverlayContainer && activeOverlayContainer.contains(target)) return;
    // Inside the active SVG itself -> stay editing.
    if (activeSvg && activeSvg.contains(target as Node)) return;
    // Otherwise the user clicked a sibling element / canvas / parent —
    // signal the parent to clear shapeEditingIdAtom. Persistence happens
    // via SvgEditorOverlay's unmount cleanup pulling commitShapeEdit().
    outsideEmitted = true;
    trace.action('shape-edit-host:outside-click-exit', { nodeId: activeNodeId });
    emit({ type: 'shapeEditCancelled' });
  };
  document.addEventListener('mousedown', onDocumentMouseDownCapture, true);

  (activeOverlayContainer as any).__cleanupListeners = () => {
    activeOverlayContainer?.removeEventListener('pointerdown', onContainerPointerDown);
    window.removeEventListener('pointerup', onWindowPointerUp);
    document.removeEventListener('mousedown', onDocumentMouseDownCapture, true);
  };

  // Adapter: library reads/writes through this. All synchronous DOM
  // operations in the iframe — no Comlink, no async, no jitter.
  // `getSvgContent` always serializes fresh from the live SVG element so
  // that `editor.reload()` picks up any wrapper changes we made
  // imperatively (e.g. post-pointerup wrapper normalize). Returning a
  // cached snapshot would freeze the library's `this.doc.viewBox` to the
  // pre-normalize value and anchors would render in the OLD coord space
  // while the painted path renders in the new one — anchors visibly
  // detach from path vertices after every reshape.
  const adapter: SvgEditorAdapter = {
    getPathData: () => '',
    setPathData: () => { /* unused in multi-shape mode */ },
    getSvgContent: () => activeSvg ? svgElementToMarkup(activeSvg) : currentMarkupRef,
    setSvgContent: (newSvg: string) => {
      currentMarkupRef = newSvg;
      const innerJSX = extractInnerSvg(newSvg);
      pendingInnerJSX = innerJSX;
      // Live preview: replace the SVG's children directly. Synchronous,
      // zero IPC. The browser paints the next frame with the new path.
      if (activeSvg) {
        // Preserve renderer-injected stroke-alignment artifacts across the
        // innerHTML overwrite: the editor library doesn't know about our
        // `<defs data-rev-defs>` block or the per-shape `clip-path`
        // attribute, so without this snapshot/restore Inside alignment
        // visibly drops on every anchor drag (centered stroke flashes
        // wide) until the next full render rebuilds the def.
        const savedDefs = activeSvg.querySelector(':scope > defs[data-rev-defs="1"]') as SVGDefsElement | null;
        const SHAPE_TAGS = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path']);
        // Per-shape snapshot of attrs the library's innerHTML overwrite would
        // strip but that we need to survive the round-trip:
        //   - `clip-path` — points at the renderer-injected `<clipPath>` def
        //     (rebuilt on next render but the in-DOM ref keeps Inside visible
        //     mid-drag).
        //   - `data-stroke-align` — the source-of-truth for Inside/Outside.
        //     Without preserving this, the next render's `applyStrokeAlignment`
        //     reads `attrs['data-stroke-align'] === undefined`, hits the
        //     cleanup branch, removes the `<clipPath>` def, and the shape
        //     visually snaps to Center on commit even though the user never
        //     touched the Align dropdown.
        // Per-shape snapshot. `data-id` (and the renderer-stamped
        // `data-node-id`) need preserving on top of clip-path/align
        // because Outside alignment is applied via a CSS rule keyed by
        // `[data-id="…"]` (paint-order: stroke fill). If we let the
        // library's innerHTML overwrite strip the data-id, the rule
        // stops matching and the stroke visually snaps to Center for
        // every drag tick until the next renderer pass restamps it.
        const savedAttrsByIndex = new Map<number, { clipPath?: string; align?: string; dataId?: string; dataNodeId?: string }>();
        let shapeIdx = 0;
        for (const child of Array.from(activeSvg.children)) {
          if (!SHAPE_TAGS.has(child.tagName.toLowerCase())) continue;
          const cp = child.getAttribute('clip-path');
          const align = child.getAttribute('data-stroke-align');
          const dataId = child.getAttribute('data-id');
          const dataNodeId = child.getAttribute('data-node-id');
          if ((cp && cp.startsWith('url(#rev-stroke-clip-')) || align || dataId || dataNodeId) {
            savedAttrsByIndex.set(shapeIdx, {
              clipPath: cp && cp.startsWith('url(#rev-stroke-clip-') ? cp : undefined,
              align: align || undefined,
              dataId: dataId || undefined,
              dataNodeId: dataNodeId || undefined,
            });
          }
          shapeIdx++;
        }

        activeSvg.innerHTML = innerJSX;

        if (savedDefs) activeSvg.insertBefore(savedDefs, activeSvg.firstChild);
        if (savedAttrsByIndex.size > 0) {
          let i = 0;
          for (const child of Array.from(activeSvg.children)) {
            if (!SHAPE_TAGS.has(child.tagName.toLowerCase())) continue;
            const saved = savedAttrsByIndex.get(i);
            if (saved) {
              if (saved.clipPath) child.setAttribute('clip-path', saved.clipPath);
              if (saved.align) child.setAttribute('data-stroke-align', saved.align);
              if (saved.dataId) child.setAttribute('data-id', saved.dataId);
              if (saved.dataNodeId) child.setAttribute('data-node-id', saved.dataNodeId);
            }
            i++;
          }
        }
        // Sync each clipPath's geometry with the SHAPE's current geometry —
        // anchor drags change `d`/`points` per frame and the saved
        // clipPath still has the pre-drag geometry, so without this resync
        // the clip outline visibly lags the painted stroke during edit.
        if (savedDefs) {
          const GEOMETRY_ATTRS = new Set(['d', 'points', 'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'transform']);
          for (const child of Array.from(activeSvg.children)) {
            if (!SHAPE_TAGS.has(child.tagName.toLowerCase())) continue;
            const cpAttr = child.getAttribute('clip-path');
            if (!cpAttr) continue;
            const idMatch = cpAttr.match(/url\(#(rev-stroke-clip-[^)]+)\)/);
            if (!idMatch) continue;
            const clipEl = savedDefs.querySelector('#' + CSS.escape(idMatch[1]));
            if (!clipEl) continue;
            while (clipEl.firstChild) clipEl.removeChild(clipEl.firstChild);
            const geom = document.createElementNS('http://www.w3.org/2000/svg', child.tagName.toLowerCase());
            for (const a of Array.from(child.attributes)) {
              if (GEOMETRY_ATTRS.has(a.name)) geom.setAttribute(a.name, a.value);
            }
            clipEl.appendChild(geom);
          }
        }
        // Live auto-fit during reshape so the flex layout tracks the morph each
        // frame instead of only on shape-edit exit:
        //   • child of a FLEX SVG GROUP → re-fit the group to the painted bounds
        //     (the edited child's own box/anchors stay stable).
        //   • STANDALONE flex shape → can't re-fit its OWN box mid-drag (anchor
        //     viewBox desync), so re-centre via left/top with box+viewBox fixed.
        const reshapeParent = activeSvg.parentNode as Element | null;
        if (reshapeParent && reshapeParent.tagName && reshapeParent.tagName.toLowerCase() === 'svg') {
          // Refit the WHOLE chain live (nested group → … → top-level flex group),
          // so a grandchild reshape reflows the flex layout each frame. On the
          // canvas (absolute top) this is a no-op → commit-time refit.
          liveRefitGroupChainEl(reshapeParent as SVGSVGElement);
        } else {
          liveRecenterStandaloneFlexShape(activeSvg);
        }
      }
    },
    getViewBox: () => {
      if (!activeSvg) return { x: 0, y: 0, width: 100, height: 100 };
      const vb = activeSvg.getAttribute('viewBox');
      if (vb) {
        const parts = vb.split(/[\s,]+/).map(Number);
        return { x: parts[0] || 0, y: parts[1] || 0, width: parts[2] || 100, height: parts[3] || 100 };
      }
      const w = parseFloat(activeSvg.style.width || '100') || 100;
      const h = parseFloat(activeSvg.style.height || '100') || 100;
      return { x: 0, y: 0, width: w, height: h };
    },
    // Return the UN-ROTATED CSS box dimensions on screen (not the
    // post-rotation AABB). The library uses this rect to compute
    // `pxToVbX` / `pxToVbY` for `buildAnchorMarkup` — those ratios
    // drive the anchor circles' rx/ry. With the rotated AABB,
    // width != height-proportional-to-viewBox so the library draws
    // anchors as ellipses to compensate for the asymmetric stretch.
    // BUT our overlay container is now positioned at the un-rotated
    // CSS box AND CSS-rotates separately — the overlay's internal
    // viewBox→box mapping is UNIFORM, so the library's compensation
    // becomes a distortion (anchors look like ovals). Returning the
    // un-rotated CSS box keeps pxToVbX == pxToVbY → round anchors.
    getSvgRect: () => {
      const ctm = getActiveSvgFullCTM();
      if (!ctm) return getActiveSvgScreenRect();
      // Derive un-rotated CSS box from CTM magnitudes.
      const scaleX = Math.sqrt(ctm.a * ctm.a + ctm.b * ctm.b);
      const scaleY = Math.sqrt(ctm.c * ctm.c + ctm.d * ctm.d);
      // Read viewBox to get user-space dimensions + origin.
      let vbX = 0, vbY = 0, vbW = 0, vbH = 0;
      if (activeSvg) {
        const vbAttr = activeSvg.getAttribute('viewBox');
        if (vbAttr) {
          const parts = vbAttr.split(/[\s,]+/).map(Number);
          vbX = parts[0] || 0; vbY = parts[1] || 0; vbW = parts[2] || 0; vbH = parts[3] || 0;
        }
        if (!vbW || !vbH) {
          vbW = parseFloat(activeSvg.style.width || '0') || 100;
          vbH = parseFloat(activeSvg.style.height || '0') || 100;
        }
      } else { vbW = 100; vbH = 100; }
      const boxW = vbW * scaleX;
      const boxH = vbH * scaleY;
      // Centre from the CTM (== the rotation fixed point: viewBox centre mapped
      // through the FULL chain), NOT the AABB centre — `getActiveSvgScreenRect`
      // drops a rotated nested group's rotation, which offsets the library's box
      // from the (CTM-based) overlay container and scatters the anchors. Same
      // centre `computeOverlayGeom` uses, so library box == container.
      const centerScreen = new DOMPoint(vbX + vbW / 2, vbY + vbH / 2).matrixTransform(ctm);
      const cx = centerScreen.x, cy = centerScreen.y;
      return {
        left: cx - boxW / 2,
        top: cy - boxH / 2,
        width: boxW,
        height: boxH,
      };
    },
    // Full user-space → screen matrix INCLUDING every CSS transform in
    // the chain (CSS individual rotate / scale / translate properties,
    // the `transform` property, parent transforms). Computed via
    // `getBoxQuads` — see getActiveSvgFullCTM for rationale. The
    // alternative `activeSvg.getScreenCTM()` misses CSS `rotate: 72deg`
    // in some Chromium versions, which is the property framer-motion
    // emits for a rotated motion node.
    getScreenCTM: () => getActiveSvgFullCTM(),
  };

  activeEditor = new SvgPathEditor({
    adapter,
    onChange: (d: string) => {
      trace.fn('shape-edit-host:onChange', { nodeId });
      // A real model change happened → this session is no longer a no-op.
      activeEditDirty = true;
      // Pen-creation: when the user CLOSES the path (a `Z` appears), drawing is
      // done. Leave pen-creation mode and shrink the viewport-sized seed to the
      // shape so the overlay returns to shape-size — then the next click on EMPTY
      // canvas falls OUTSIDE the overlay, reaches the parent, and exits + commits
      // (the normal click-outside-shape exit). Without this the full-viewport
      // overlay ate every click and the shape never left edit mode.
      if (activePenMode && /[Zz]/.test(d) && activeSvg) {
        activePenMode = false;
        const cssT = activeSvg.style.transform || getComputedStyle(activeSvg).transform;
        const hasCssT = !!cssT && cssT !== 'none' && cssT.trim() !== '';
        if (!hasCssT) {
          const bounds = computeNormalizedBounds(activeSvg);
          if (bounds) {
            applyBoundsToWrapper(activeSvg, bounds);
            try { activeEditor?.reload(); } catch { /* keep going */ }
          }
        }
        trace.action('shape-edit-host:pen-closed-shrink', { nodeId });
      }
    },
    onSelectionChange: () => { /* could ferry to parent if a panel needs it */ },
    onToolChange: () => { /* same */ },
    onAnchorInfo: (info) => {
      emit({ type: 'anchorInfo', info });
    },
    onRequestExit: () => {
      // Pen-CREATION only: clicking empty canvas in select mode FINISHES the draw
      // (parent exits shape-edit → overlay unmount commits). For a normal edit
      // session the editor just clears its selection (no-op here).
      if (activePenMode) {
        trace.action('shape-edit-host:pen-request-exit', { nodeId });
        emit({ type: 'shapeEditDone' });
      }
    },
  });
  activeEditor.attach(activeOverlayContainer);

  // Path-TOOL creation enters with pen=true: the SAME editor (vertex select /
  // curve / properties / drag) but the PEN tool active, so the user places points
  // AND edits any vertex mid-draw (the reference pen). The seed node is viewport-sized,
  // so the overlay covers the canvas and the pen catches clicks anywhere.
  activePenMode = pen;
  // Pen-creation is ALWAYS an edit (the user is drawing); a re-edit starts clean
  // and only becomes dirty once onChange fires from a real vertex/handle change.
  activeEditDirty = pen;
  // Resume-pen ("click the end vertex to keep drawing") is a LIVE-drawing
  // convenience — it must only work inside the pen-creation session, never when
  // re-editing a committed path. Tie it to the same pen flag so double-clicking a
  // finished shape lets you EDIT vertices without re-entering the pen.
  activeEditor.allowResumePen = pen;
  if (pen) {
    try { activeEditor.setTool('pen'); } catch (err) { trace.error('shape-edit-host:setTool-pen-failed', String(err)); }
  }

  trace.action('shape-edit-host:started', { nodeId, vpPrefix, pen });
}

/** Commit current state and return the payload synchronously to the
 *  caller via Comlink. Returning directly (instead of emitting an
 *  event) is critical for the unmount-cleanup path: React clears its
 *  effect callbacks immediately, so any postMessage event arriving
 *  AFTER the cleanup function returns lands on a dead handler. With
 *  RPC, the parent's `await bridge.commitShapeEdit()` resolves with
 *  the payload; the parent queues source mutations before the handler
 *  registration can be torn down. */
export function commitShapeEdit(): {
  nodeId: string;
  vpPrefix: string;
  innerJSX: string;
  shapes: { dataId: string; d: string }[];
  wrapper: { viewBox: string; widthPx: string; heightPx: string; leftPx: string; topPx: string };
} | null {
  if (!activeEditor || !activeSvg || !activeNodeId) {
    cleanup();
    return null;
  }

  // NO-OP guard: the user entered shape-edit and exited without editing anything.
  // Committing anyway re-serializes the shape from the editor's live DOM — which
  // turns a <polygon> into a <path> and stamps child ids — visually identical but
  // it breaks a later variant resize (the stamped child changes the resize path).
  // Returning null makes the parent skip ALL commit mutations, leaving source as-is.
  if (!activeEditDirty) {
    trace.action('shape-edit-host:committed-noop-skip', { nodeId: activeNodeId });
    cleanup();
    return null;
  }

  // Final state. The library's setSvgContent during drag has already
  // populated activeSvg.innerHTML directly, so reading from the live
  // element gives us the canonical post-drag geometry.
  //
  // Strip `data-node-id` / `data-id` from the captured markup before
  // writing it to source. The renderer stamps both onto every live DOM
  // element on every render; if we let them leak back into JSX, the
  // parser keeps the literal `auto_N` instead of generating a fresh one,
  // and the per-file auto-counter goes on to collide with that baked
  // id on the next anonymous shape. Result: two different shapes end
  // up sharing `data-node-id="auto_11"`, the renderer's element lookups
  // hit the wrong one, and edits to shape A start mutating shape B's
  // DOM. Same fix also strips `clip-path` / `paint-order` inline
  // styles the renderer applied (see `applyStrokeAlignment` in
  // Renderer.ts) so they don't get baked into source either.
  const innerJSX = stripRendererArtifacts(activeSvg.innerHTML);
  // Skip wrapper-normalize for rotated shapes — same rationale as in
  // `onWindowPointerUp` above: under a CSS rotate, normalizing the
  // wrapper translates the rotation pivot and visually jumps the shape
  // on commit. We accept some padding in the viewBox to keep the shape
  // pinned to the screen position the user dragged it to.
  const commitCssTransform = activeSvg.style.transform || getComputedStyle(activeSvg).transform;
  const commitHasCssTransform = !!commitCssTransform && commitCssTransform !== 'none' && commitCssTransform.trim() !== '';
  const bounds = commitHasCssTransform ? null : computeNormalizedBounds(activeSvg);

  // Apply normalized bounds imperatively so the iframe shows the final
  // state during the brief window before source mutations re-render.
  if (bounds) applyBoundsToWrapper(activeSvg, bounds);

  // Per-shape geometry (document order, index-aligned with ensureShapeChildIds)
  // so the parent can route each shape's `d` per tile instead of overwriting
  // the whole inner markup unconditionally.
  const shapes = extractShapeGeometry(activeSvg, activeNodeId);

  const payload = {
    nodeId: activeNodeId,
    vpPrefix: activeVpPrefix,
    innerJSX,
    shapes,
    wrapper: bounds || {
      viewBox: activeSvg.getAttribute('viewBox') || '',
      widthPx: activeSvg.style.width || '',
      heightPx: activeSvg.style.height || '',
      leftPx: activeSvg.style.left || '',
      topPx: activeSvg.style.top || '',
    },
  };

  trace.action('shape-edit-host:committed', { nodeId: activeNodeId, hasNewBounds: !!bounds });
  cleanup();
  return payload;
}

/** Cancel without committing — Escape, etc. Iframe state stays as-is
 *  (live bridge.setInnerHTML writes during drag are NOT rolled back;
 *  the next renderer.render from any cause will re-apply source). */
export function cancelShapeEdit(): void {
  if (!activeEditor) return;
  emit({ type: 'shapeEditCancelled' });
  cleanup();
}

export function isShapeEditing(): boolean {
  return activeEditor !== null;
}

/** Set the handle mode (curve type) of the currently-selected anchor.
 *  Called by the parent's Path tool when the user picks Straight /
 *  Mirrored / Disconnected from the Curve segmented control. No-op
 *  when shape-edit isn't active. */
export function setShapeEditHandleMode(mode: 'straight' | 'mirrored' | 'disconnected'): void {
  if (!activeEditor) return;
  try {
    activeEditor.setHandleMode(mode);
  } catch (err) {
    trace.error('shape-edit-host:setHandleMode-failed', String(err));
  }
}

/** Move the currently-selected anchor to an absolute SVG-space position.
 *  Called by the parent's Path tool when the user types into the
 *  Position x / y inputs. Looks up the currently-selected anchor (single
 *  selection only — multi-select fall-through is a no-op) and forwards
 *  to `editor.setAnchorPosition`. */
export function setShapeEditAnchorPosition(x: number, y: number): void {
  if (!activeEditor) return;
  const sel = activeEditor.currentSelection;
  if (sel.anchorRefs.length !== 1) return;
  const ref = sel.anchorRefs[0];
  try {
    activeEditor.setAnchorPosition({ shapeIndex: ref.shapeIndex, anchorIndex: ref.anchorIndex }, x, y);
  } catch (err) {
    trace.error('shape-edit-host:setAnchorPosition-failed', String(err));
  }
}

/** Called after the parent's SvgShapeTool writes an attribute on the
 *  inner shape (fill / stroke / cap / join / etc) via the bridge. The
 *  iframe DOM already reflects the change at that point — but the
 *  active library editor has its OWN parsed model of the shapes and
 *  serializes from that on the next drag, so without a re-sync the
 *  next pointermove would write the OLD fill back into the DOM.
 *  `reload()` re-parses from the live SVG (via our adapter's
 *  `getSvgContent` which serializes fresh from `activeSvg`), so the
 *  library's internal model picks up the panel's edit and preserves
 *  it across subsequent drags. No-op when shape edit isn't active. */
export function syncEditorFromLiveSvg(): void {
  if (!activeEditor) return;
  // `reload()` clears the library's selection back to empty (see
  // SvgPathEditor.reload). Without preserving across the reload,
  // scrubbing the Width or Array chevron in the right panel — which
  // fires `setChildShapeAttribute` per mousemove tick — would clear
  // the user's selected anchor on every tick and the editor handles
  // (anchor circles, segment dots, bezier handles) disappear mid-edit.
  // Capture the current selected anchor, run reload, re-select.
  const priorSel = activeEditor.currentSelection;
  const restoreTarget = priorSel.anchorRefs.length === 1
    ? { shapeIndex: priorSel.anchorRefs[0].shapeIndex, anchorIndex: priorSel.anchorRefs[0].anchorIndex }
    : null;
  // Also snapshot handleMode so the panel-edit / reload round-trip doesn't
  // silently downgrade a Mirrored / Disconnected anchor back to Straight
  // when the underlying path commands are still linear. Re-applied after
  // reload via `setHandleMode` on the re-selected anchor.
  let priorHandleMode: 'straight' | 'mirrored' | 'disconnected' | null = null;
  if (restoreTarget) {
    const a = activeEditor.shapes[restoreTarget.shapeIndex]?.path.anchors[restoreTarget.anchorIndex];
    if (a) priorHandleMode = a.handleMode;
  }
  try {
    activeEditor.reload();
  } catch (err) {
    trace.error('shape-edit-host:reload-from-panel-failed', String(err));
  }
  if (restoreTarget) {
    try { activeEditor.selectAnchor(restoreTarget); } catch (err) {
      trace.error('shape-edit-host:reselect-after-panel-failed', String(err));
    }
    if (priorHandleMode && priorHandleMode !== 'straight') {
      try { activeEditor.setHandleMode(priorHandleMode); } catch (err) {
        trace.error('shape-edit-host:rehandlemode-after-panel-failed', String(err));
      }
    }
  }
}

// ─── Internals ───────────────────────────────────────────────────────────

function cleanup(): void {
  if (activeOverlayContainer) {
    const rafId = (activeOverlayContainer as any).__rafId as number | undefined;
    if (rafId !== undefined) cancelAnimationFrame(rafId);
    const cleanupListeners = (activeOverlayContainer as any).__cleanupListeners as (() => void) | undefined;
    cleanupListeners?.();
    activeOverlayContainer.remove();
    activeOverlayContainer = null;
  }
  if (activeSvg) {
    activeSvg.removeAttribute('data-shape-editing');
    activeSvg = null;
  }
  if (activeEditor) {
    try { activeEditor.detach(); } catch { /* ignore */ }
    activeEditor = null;
  }
  removeEditStyles();
  activeNodeId = null;
  activeVpPrefix = '';
  initialMarkupRef = '';
  currentMarkupRef = '';
  isDragging = false;
  pendingInnerJSX = null;
  activePenMode = false;
  activeEditDirty = false;
  _startShapeEditRetries = 0;
}
