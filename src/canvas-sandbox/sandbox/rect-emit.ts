// rect-emit.ts — rect / corners / computed-cache emission for the sandbox.
// Extracted verbatim from bridge-sandbox.ts (Phase 7 split). Holds the
// corner-geometry helpers (cornersForElement + the unified SVG coordinate
// context) and the per-element / subtree / all-rects refresh emitters that
// keep the parent-frame caches in sync during live interactions.
// `emitRectAndCornersForElement` living HERE (not in bridge-sandbox) is what
// breaks the bridge-sandbox ↔ sandbox-code-host circular import.

import type { SandboxEvent } from '../protocol';
import { trace } from '@/shared/debug-trace';
import { getScreenCorners, cornersFromRect } from '@/canvas/resize/geometry-utils';
import { pathPoints } from '@/shared/svg-geometry';
import { firstSvgShapeChild, getInnerShapeTransformMatrix } from '../shape-edit-host';
import {
  getSvgWrapperViewBoxAffine, getSvgFullAffine, affineBoxCorners,
  multiply, applyAffine, IDENTITY, nestedChildAffine, readNestedChildParams,
  type Affine, type SvgCtmContext,
} from '../svg-user-to-screen';
import { isSandboxDndInteracting } from '../sandbox-dnd-host';
import { contentRoot, currentSandboxTransform, emit } from './sandbox-state';
import { replayOverlayPlacements } from '@/canvas/renderer/overlay-portals';

/** getBBox guarded against throwing / degenerate (zero-area) results. */
function safeBBox(el: { getBBox?: () => DOMRect } | null): DOMRect | null {
  if (!el || typeof el.getBBox !== 'function') return null;
  try { const b = el.getBBox(); return (b.width > 0 && b.height > 0) ? b : null; } catch { return null; }
}

// Screen corners for any element. ALL SVG geometry routes through the unified
// deterministic matrix (svg-user-to-screen.ts) — no getBoxQuads / getScreenCTM
// (both unreliable for our nested-viewBox + CSS-rotated SVGs). One path handles
// group/standalone, rotated/un-rotated, and nested-in-rotated-group uniformly.
export function cornersForElement(el: Element, rotMemo?: Map<Element, boolean>): ReturnType<typeof getScreenCorners> {
  const tag = el.tagName.toLowerCase();

  if (tag === 'svg') {
    // FIT-text wrapper: an <svg> that wraps a <foreignObject> (HTML text scaled
    // by the viewBox — see fit-text-gen.ts) is NOT vector art. It has no shape
    // child, so it falls into the SVG-GROUP path below where getBBox /
    // paintedGroupUserBounds return a DEGENERATE user-space box (no vertices) →
    // the selection overlay collapsed to a tiny sliver on the left. Its rendered
    // box IS its screen rect, same as any HTML element — short-circuit to that.
    if (el.querySelector(':scope > foreignObject')) {
      return cornersFromRect((el as unknown as HTMLElement).getBoundingClientRect());
    }
    const svg = el as SVGSVGElement;
    const ctx = svgCtmContext();
    const shapeChild = firstSvgShapeChild(svg);
    if (shapeChild) {
      // SINGLE SHAPE (standalone OR a leaf shape inside a group): map the inner
      // shape's UN-rotated geometry bbox through the FULL CTM (the <svg> ancestor
      // chain · the inner shape's `transform` attr). Composes any ancestor GROUP
      // CSS rotation AND the shape's own attribute rotation — the box fits the
      // rotated shape even nested inside a rotated group.
      const m = getSvgFullAffine(svg, ctx);
      const b = safeBBox(shapeChild);
      if (m && b) return affineBoxCorners(m, b.x, b.y, b.width, b.height);
    } else {
      // GROUP <svg> (children are nested <svg> wrappers): the outline must hug
      // the actual painted geometry — for a rotated CHILD that means its rotated
      // vertices, NOT the loose union of child BOXES that `getBBox` returns
      // (standard tight fit). `paintedGroupUserBounds` computes the tight
      // per-vertex bounds in the group's user space (inner rotation folded in);
      // M_topSvg then maps them, so the outline is tight AND rotates with the
      // group + tracks live child edits. Falls back to getBBox.
      const m = getSvgWrapperViewBoxAffine(svg, ctx);
      if (m) {
        const ub = paintedGroupUserBounds(svg);
        if (ub) return affineBoxCorners(m, ub.x, ub.y, ub.w, ub.h);
        const b = safeBBox(svg);
        if (b) return affineBoxCorners(m, b.x, b.y, b.width, b.height);
      }
    }
    return cornersFromRect((el as HTMLElement).getBoundingClientRect());
  }

  // SVG SHAPE element (polygon/path/rect/…): hit region = its geometry bbox
  // mapped through the parent <svg>'s full CTM (includes this shape's transform
  // attr + any ancestor group rotation). Deterministic + bounded — replaces the
  // getBoxQuads/marker fallbacks that produced canvas-spanning hit regions.
  if (SVG_SHAPE_HIT_TAGS.has(tag)) {
    const parentSvg = el.parentElement;
    if (parentSvg && parentSvg.tagName.toLowerCase() === 'svg') {
      const m = getSvgFullAffine(parentSvg as unknown as SVGSVGElement, svgCtmContext());
      const b = safeBBox(el as unknown as { getBBox?: () => DOMRect });
      if (m && b) return affineBoxCorners(m, b.x, b.y, b.width, b.height);
    }
    return cornersFromRect((el as unknown as HTMLElement).getBoundingClientRect());
  }

  return getScreenCorners(el, rotMemo);
}

// SVG geometry tags whose hit corners fall back to getBoundingClientRect when
// rotated (see cornersForElement). Exported for the measure pass: these
// corners are GEOMETRY-mapped (affine bbox), which legitimately differs from
// the element's CSS rect — they must be flagged `decoupled` or the host's
// corners-vs-rect stale check mass-rejects every vector shape on every pass
// (traced: 1.4k cornersUpdate-rejected-stale per sweep on vector-heavy pages).
export const SVG_SHAPE_HIT_TAGS = new Set(['polygon', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline']);

/** True when an element's emitted corners are GEOMETRY-mapped and thus
 *  intentionally differ from its CSS rect — svg wrappers AND svg shape
 *  children. Every cornersUpdate emitter must pass this as `decoupled` so
 *  the host's corners-vs-rect stale check doesn't mass-reject vector art. */
export function cornersAreDecoupled(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  return tag === 'svg' || SVG_SHAPE_HIT_TAGS.has(tag);
}

// Style props that re-position descendants when patched on a parent.
// `transform` already triggered subtree refresh for viewport-header drag;
// the others land via the gap / padding handles and via the Layout
// tool's flex/grid container controls. Without subtree refresh, the
// parent's rect updates but children's positions in the host's
// rectCache stay stale → overlays that read child rects (gap handles,
// padding handles, drop-line indicator, parent-relative selection
// math) lag or jump on commit. Per-element emit (not `allRects`) to
// preserve cornersCache accuracy for rotated descendants.
const SUBTREE_REFRESH_PROPS = new Set([
  'transform',
  'gap', 'rowGap', 'columnGap',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'display', 'flexDirection', 'flexWrap', 'justifyContent', 'alignItems',
  'alignContent', 'gridTemplateColumns', 'gridTemplateRows', 'gridGap',
  'gridColumnGap', 'gridRowGap', 'gridAutoFlow', 'gridAutoColumns',
  'gridAutoRows',
  // FLOW-affecting per-item props. An absolute→relative flip (Position
  // Type control) re-flows the SIBLINGS — the moved sibling (a code
  // component in the live find, 2026-07-19) kept its stale cached rect and
  // was un-hoverable/un-selectable until a camera move. left/top on an
  // absolute child move its own subtree the same way (panel X/Y edits).
  // Drag-time storms are unaffected: the per-frame drag patches hit the
  // isSandboxDndInteracting gate and stay element-only.
  'position', 'left', 'top', 'right', 'bottom', 'inset',
  'order', 'flex', 'flexGrow', 'flexShrink', 'flexBasis',
  'alignSelf', 'justifySelf',
]);

export function shouldRefreshSubtree(styles: Record<string, string>): boolean {
  for (const key of Object.keys(styles)) {
    if (SUBTREE_REFRESH_PROPS.has(key)) return true;
  }
  return false;
}

// Exported so sandbox-code-host can push a rect refresh when a CDN
// bundle finishes mounting. The wrapper's size goes from placeholder
// (min 100×40) to the bundle's real content size on the React commit
// after the dynamic-import resolves — without an explicit rectUpdate,
// the parent's rectCache holds the stale placeholder rect until
// some other mutation (e.g. a drag) walks the subtree refresh.
export function emitRectAndCornersForElement(el: HTMLElement): void {
  emitElementRefresh(el, emit);
}

// Full positional re-measure of every node's RECT + CORNERS — no DOM rebuild,
// no computed-style recompute. Used when an ASYNC code-code component grows
// AFTER the initial synchronous measurement pass: an auto-sized wrapper only
// takes its real size once the Code component's own effects run (e.g. a marquee flips
// its connected children absolute→relative inside a useEffect, so the wrapper
// is collapsed at `allRects` time and grows a frame later). When the wrapper
// grows, EVERYTHING below it in flow shifts down — not just its ancestors but
// every following sibling and their descendants (e.g. the FAQ section under a
// testimonials marquee). A per-element or ancestor-only refresh leaves those
// following nodes' cached rects stale, so their selection/hover overlays sit
// offset until a drag forces a full re-render. Re-emitting every node's rect
// fixes the whole shift. Computed styles are deliberately NOT re-emitted: a
// pure positional shift changes no node's CSS (width/gap/padding/size), so the
// parent's computedCache stays valid — this keeps the pass cheap. rAF-debounced
// so a burst of ResizeObserver ticks coalesces into one measure per frame, and
// it never touches the React roots (no Code component teardown — satisfies the Map
// system "never destroy+rebuild" rule).
let _remeasureRaf = 0;
let _remeasureTimer: ReturnType<typeof setTimeout> | null = null;
// FORCE variant: cancel any pending (possibly premature) remeasure and schedule
// a fresh one. A reorder posts restoreNode + order-clears as separate messages;
// the leading-edge debounce below can let a rAF pending from the LIFT fire
// BETWEEN them, measuring the pre-clear layout → stale overlay corners. The
// strategy calls this AS ITS LAST op so the measure lands after every mutation.
export function forceRemeasureAllRects(): void {
  if (_remeasureTimer) { clearTimeout(_remeasureTimer); _remeasureTimer = null; }
  if (_remeasureRaf) { cancelAnimationFrame(_remeasureRaf); _remeasureRaf = 0; }
  runRemeasureOnNextFrame(true);
}
/** TRAILING debounce (150ms). This entry point is fed by ResizeObservers on
 *  code-component wrappers — during a live resize DRAG of an instance they
 *  re-request EVERY FRAME, and the old leading rAF debounce ran a FULL-PAGE
 *  remeasure ~16×/s (traced: 33 sweeps in a 2s height drag = the "resize is
 *  super slow" find). One-shot async growth (a marquee mounting late) only
 *  needs the measure to land shortly AFTER it settles — trailing is correct.
 *  Gesture-critical paths use forceRemeasureAllRects (immediate) instead. */
// ─── DOM-settle observer ────────────────────────────────────────────────────
// "Anything that updates the DOM must recalc the overlays without panning."
// The render-time measure captures geometry BEFORE framer-motion layout
// animations (FLIP/glide) settle — a canvas→viewport drop measured mid-glide
// left every selection/hover overlay at the pre-settle position until a
// camera move ran the idle heal (live find 2026-07-22). This observer pipes
// subtree mutations into the debounced scheduler: every style/childList
// mutation re-arms the 150ms timer, so ONE measure lands right after the DOM
// goes quiet. Continuous animations (marquees, spring loops) re-arm forever —
// a max-latency backstop forces a pass every 1200ms while mutations churn so
// real edits underneath them still heal.
let _settleObserver: MutationObserver | null = null;
let _settlePendingSince = 0;

export function startSettleObserver(): void {
  if (_settleObserver || typeof MutationObserver === 'undefined' || !contentRoot) return;
  _settleObserver = new MutationObserver((records) => {
    // Mid-gesture the drag keeps its caches fresh imperatively and the
    // gesture-end reconcile runs a full sweep — skip (and DON'T re-arm off
    // our own culling writes: data-culled flips are measurement plumbing).
    if (isSandboxDndInteracting()) return;
    let relevant = false;
    for (const r of records) {
      const t = r.target as HTMLElement;
      if (t === contentRoot) continue; // camera transform writes
      if (r.type === 'attributes' && (t.hasAttribute?.('data-culled') || r.attributeName === 'data-culled' || r.attributeName === 'data-culled-dirty')) continue;
      relevant = true;
      break;
    }
    if (!relevant) return;
    if (_settlePendingSince === 0) _settlePendingSince = performance.now();
    // Max-latency backstop: mutations churning for >1200ms (infinite
    // animation) — land a pass anyway, then restart the quiet window.
    if (performance.now() - _settlePendingSince > 1200) {
      _settlePendingSince = 0;
      if (_remeasureTimer) { clearTimeout(_remeasureTimer); _remeasureTimer = null; }
      runRemeasureOnNextFrame();
      return;
    }
    scheduleRemeasureAllRects();
  });
  _settleObserver.observe(contentRoot, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['style', 'data-variant', 'width', 'height', 'd', 'x', 'y'],
  });
  trace.action('sandbox:settle-observer-started', {});
}

export function scheduleRemeasureAllRects(): void {
  if (_remeasureTimer) clearTimeout(_remeasureTimer);
  _remeasureTimer = setTimeout(() => {
    _remeasureTimer = null;
    runRemeasureOnNextFrame();
  }, 150);
}
function runRemeasureOnNextFrame(force = false): void {
  if (_remeasureRaf) return;
  _remeasureRaf = requestAnimationFrame(() => {
    _remeasureRaf = 0;
    if (!contentRoot) return;
    // MID-DRAG GATE (scheduled sweeps only — `force` = gesture-critical
    // commit-time callers bypass it). ResizeObservers on code-component
    // wrappers fire during drags and this sweep used to run FULL-PAGE
    // mid-gesture: on a 2.9k-element page that's the traced 130–160ms
    // stall, and its thousands of per-element rect/corner messages raced
    // the newer allRects state into a cornersUpdate-rejected-stale storm
    // (1600 rejections in one 7s drag). The drag keeps its own caches
    // fresh imperatively; re-arm and land the sweep once the gesture ends.
    if (!force && isSandboxDndInteracting()) {
      scheduleRemeasureAllRects();
      return;
    }
    _settlePendingSince = 0;
    void contentRoot.offsetHeight; // flush layout before reading rects
    trace.action('sandbox:remeasure-all-rects', { force });
    // RE-PLACE portaled overlays before measuring. A relative overlay's position
    // is DERIVED from its trigger's rect, so it has to converge wherever the
    // geometry converges — and this is the single funnel every full measure goes
    // through (settle observer, camera-idle heal, forceRemeasureAllRects).
    //
    // Doing it only at the raw gesture-end instant was not enough: a layout
    // reorder animates via framer-motion's `layout` FLIP, so at mouseup the
    // trigger is still at its OLD rect and the overlay was re-placed onto the
    // pre-animation position — indistinguishable from "it never moved". The
    // settle observer re-arms on the FLIP's own style mutations and lands here
    // once the DOM goes quiet, which is exactly when the trigger's rect is final.
    // (It also explains why panning/zooming "fixed" it: that ran a measure.)
    // Before emitAllMeasures so the overlay's new box ships in the SAME sweep —
    // otherwise its selection outline keeps the pre-drag rect. Live find
    // 2026-07-25.
    const replaced = replayOverlayPlacements(contentRoot);
    if (replaced > 0) trace.action('sandbox:remeasure-overlay-replay', { replaced, force });
    // One code path with the render-time measure pass: emitAllMeasures does
    // rects + corners + computed with culled AND offscreen-section replay,
    // batched host messages, and the per-pass rotation memo — strictly
    // fresher and far cheaper than the old per-element emit loop (which
    // sent TWO postMessages per node and re-walked ancestors per corner).
    // Dynamic import avoids a static rect-emit ↔ measure cycle.
    void import('./measure').then(({ emitAllMeasures }) => emitAllMeasures());
  });
}

export function emitElementRefresh(el: HTMLElement, emit: (e: SandboxEvent) => void): void {
  const fullId = el.getAttribute('data-node-id') || '';
  const dataId = el.getAttribute('data-id') || '';
  if (!dataId) return;
  const prefix = fullId && fullId.endsWith(dataId)
    ? fullId.slice(0, fullId.length - dataId.length)
    : '';
  const rect = el.getBoundingClientRect();
  emit({
    type: 'rectUpdate',
    nodeId: dataId,
    vpPrefix: prefix,
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
  });
  emit({
    type: 'cornersUpdate',
    nodeId: dataId,
    vpPrefix: prefix,
    corners: cornersForElement(el),
    // SVG wrappers report painted-bbox corners that decouple from the CSS
    // rect — the host must skip its rect-centre stale check for these.
    decoupled: cornersAreDecoupled(el),
  });
}

export function emitSubtreeRefresh(parent: HTMLElement, emit: (e: SandboxEvent) => void): void {
  // The scope element ITSELF first — when callers pass a layout PARENT
  // (sibling-scope refresh below), its own box can change too (auto-height
  // reflow); the double-emit when callers pass the patched element is
  // idempotent.
  emitElementRefresh(parent, emit);
  // Descendants — children's rects shift when the parent's gap /
  // padding / flex direction changes.
  const descendants = parent.querySelectorAll<HTMLElement>('[data-node-id]');
  trace.action('sandbox:subtree-refresh', { descendants: descendants.length });
  for (const child of Array.from(descendants)) emitElementRefresh(child, emit);

  // Ancestors — the patched element itself can grow/shrink (e.g. a
  // gap change on a flex container with `width: auto` resizes the
  // container), and any auto-sized ancestor cascades up. Without this,
  // overlays that lock onto an ancestor's rect — most visibly the
  // ParentHighlight dashed border around the SELECTED node's parent —
  // read pre-drag corners from the cache for the entire drag and only
  // catch up on the post-mouseup full re-render, producing the same
  // "jump from old to new position" the GapHandles RAF fix solved
  // for the handles themselves.
  let cursor = parent.parentElement;
  while (cursor && cursor !== contentRoot) {
    if (cursor.hasAttribute('data-node-id')) emitElementRefresh(cursor, emit);
    cursor = cursor.parentElement;
  }
}

// ─── Unified SVG coordinate context ──────────────────────────────────────────
// The single deterministic user-space→screen matrix (svg-user-to-screen.ts) is
// the source of truth for every SVG geometry consumer here. It needs the canvas
// zoom + an adapter for the inner shape's `transform` ATTRIBUTE (rotation lives
// there for shapes).
function innerShapeAffineAdapter(svg: SVGSVGElement): Affine | null {
  const m = getInnerShapeTransformMatrix(svg);
  return m ? [m.a, m.b, m.c, m.d, m.e, m.f] : null;
}
function svgCtmContext(): SvgCtmContext {
  return { contentRoot, zoom: currentSandboxTransform.scale || 1, innerShapeAffine: innerShapeAffineAdapter };
}

/** The svg's STABLE viewBox-user → screen affine (`M_topSvg`), as synthetic
 *  computed-style keys `__svgm0..5`. The parent-frame drag inverts it to turn a
 *  screen delta into the child's local x/y delta. CRITICAL: this is STABLE
 *  while a child is dragged — it reads the wrapper box / transform-origin /
 *  zoom, NOT `getBBox`. (The selection corners DO use getBBox so they track the
 *  live content; feeding getBBox into the DRAG frame instead made the parent
 *  frame move with the dragged child → glitchy jumps / wrong speed.) */
export function svgMatrixStyles(el: Element): Record<string, string> {
  const aff = getSvgWrapperViewBoxAffine(el as SVGSVGElement, svgCtmContext());
  if (!aff) return {};
  return {
    __svgm0: String(aff[0]), __svgm1: String(aff[1]), __svgm2: String(aff[2]),
    __svgm3: String(aff[3]), __svgm4: String(aff[4]), __svgm5: String(aff[5]),
  };
}

/** Vertices of an SVG geometry shape in its OWN local coords (before its own
 *  transform). Exact points for polygon/polyline (so a rotated triangle's group
 *  bounds hug its 3 actual vertices, standard); local-bbox corners for the
 *  rest (rect/circle/ellipse/line/path — good enough, rarely rotated tightly). */
function getShapeVertices(el: Element): Array<{ x: number; y: number }> {
  const tag = el.tagName.toLowerCase();
  if (tag === 'polygon' || tag === 'polyline') {
    const nums = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
    const out: Array<{ x: number; y: number }> = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      if (Number.isFinite(nums[i]) && Number.isFinite(nums[i + 1])) out.push({ x: nums[i], y: nums[i + 1] });
    }
    return out;
  }
  // <path> — the editor normalizes morphed shapes to a path, so this is the
  // common case AFTER a reshape. PARSE the `d` directly (pure JS, NO layout)
  // via pathPoints — NOT getTotalLength + getPointAtLength sampling, which
  // forces a synchronous reflow PER sample (~50 per path). During a grouped
  // drag/rotate/resize this function runs every frame for every child, so the
  // sampling thrashed layout into 100ms+ frames — the "circle is slow, triangle
  // is fast" gap (a polygon just reads its points; now a path does too).
  // pathPoints returns command coords: exact vertices for straight-edge
  // (morphed) paths, and endpoints+control-points for curves — for the bézier
  // ellipse those land on the box, so the bounds stay tight.
  if (tag === 'path') {
    const d = el.getAttribute('d');
    if (d) {
      const pts = pathPoints(d);
      if (pts.length) return pts.map(([x, y]) => ({ x, y }));
    }
  }
  const b = safeBBox(el as unknown as { getBBox?: () => DOMRect });
  if (b) return [
    { x: b.x, y: b.y }, { x: b.x + b.width, y: b.y },
    { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height },
  ];
  return [];
}

/** Tight per-vertex bounds of a GROUP's painted content, in the GROUP's OWN
 *  viewBox-user space. Walks every leaf shape (recursing into nested groups),
 *  maps its vertices through (child→group · inner-shape transform) and AABBs
 *  them — so a rotated child's inner rotation is folded in and the bounds hug
 *  the actual rotated geometry, NOT the loose union of child boxes that
 *  `getBBox` returns. Caller maps these 4 corners through M_topSvg, so the
 *  group outline is tight AND rotates with the group. */
function paintedGroupUserBounds(group: SVGSVGElement): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (parentSvg: SVGSVGElement, toGroup: Affine) => {
    for (const child of Array.from(parentSvg.children)) {
      if ((child.tagName || '').toLowerCase() !== 'svg') continue;
      const childSvg = child as SVGSVGElement;
      const ncp = readNestedChildParams(childSvg);
      if (!ncp) continue;
      const childToGroup = multiply(toGroup, nestedChildAffine(ncp)); // child user → group user
      const shape = firstSvgShapeChild(childSvg);
      if (shape) {
        const inner = innerShapeAffineAdapter(childSvg) ?? IDENTITY; // shape-local → child user
        const m = multiply(childToGroup, inner);                     // shape-local → group user
        for (const v of getShapeVertices(shape)) {
          const p = applyAffine(m, v.x, v.y);
          if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
        }
      } else {
        visit(childSvg, childToGroup); // nested group
      }
    }
  };
  visit(group, IDENTITY);
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
