// measure.ts — the post-render measure pass: emit EVERY element's rect +
// corners + computed styles so the host caches (rectCache / cornersCache /
// computedCache) stay 60fps-sync. Extracted from bridge-sandbox's render
// handler (it had grown into the single biggest per-operation cost).
//
// TWO replay mechanisms keep the pass proportional to what's VISIBLE:
//
// 1. CULLED subtrees (`[data-culled]`, whole offscreen tiles): display:none —
//    measuring writes zeros over valid geometry, so their last payloads are
//    replayed, re-projected through the current camera.
//
// 2. OFFSCREEN SECTIONS of a VISIBLE tile: culling is TILE-level, so zooming
//    deep INTO a big page keeps the whole tile materialised and this pass
//    used to measure its ENTIRE subtree (~rect+corners+computed per node ≈
//    100–160ms on an 800-node page) on every operation — "culling doesn't
//    help when zoomed in". A top-level section fully outside the expanded
//    viewport replays its cached payloads instead, shifted by the section's
//    own screen delta (ONE getBoundingClientRect per section): offscreen
//    sections only ever MOVE (preceding content resized) — a pure
//    translation of every cached descendant. Internal edits to offscreen
//    sections are healed by the IDLE FULL PASS scheduled after any pass
//    that skipped sections.
//
// Rect/corners are SCREEN-space at the CAPTURE-TIME camera (`t`) — replays
// must re-project through the CURRENT camera, or after a pan/zoom the stale
// screen positions land anywhere in the new view (viewport headers / labels
// / overlays "bleeding" at wrong places, live find 2026-07-17). Computed
// styles are CSS-space and replay unchanged.

import { trace } from '@/shared/debug-trace';
import type { CornersLike } from '../sandbox-api';
import { contentRoot, currentSandboxTransform, currentRenderSeq, emit } from './sandbox-state';
import { cornersForElement, svgMatrixStyles, cornersAreDecoupled } from './rect-emit';

interface MeasureEntry {
  rect: { nodeId: string; vpPrefix: string; rect: { left: number; top: number; width: number; height: number } };
  corners: { nodeId: string; vpPrefix: string; corners: CornersLike; decoupled: boolean };
  computed: { nodeId: string; vpPrefix: string; styles: Record<string, string> };
  t: { x: number; y: number; scale: number };
}

const lastEmittedMeasure = new Map<string, MeasureEntry>();

/**
 * Drop every remembered measure. MUST run on a FILE-SWITCH render: node ids
 * collide across files by design (every page and every LayoutClient measures a
 * `root` / `tablet-root` / `mobile-root`), and the offscreen/culled replay
 * would otherwise serve the PREVIOUS file's geometry for the new file's nodes.
 * Live symptom: double-clicking into a template from a long page selected the
 * template's mobile viewport with the PAGE's ~14,000px-tall replayed rect —
 * a screen-tall selection overlay until a pan forced a real measure (user
 * report 2026-07-27). After the clear, offscreen nodes simply stay absent
 * until the idle full pass measures them for real.
 */
export function clearMeasureReplayCache(): void {
  if (lastEmittedMeasure.size === 0) return;
  trace.dom('measure.clearReplayCache', { dropped: lastEmittedMeasure.size });
  lastEmittedMeasure.clear();
}

/** Re-project a capture-time screen payload into the current camera. */
function reprojectMeasure(last: MeasureEntry): { rect: MeasureEntry['rect']; corners: MeasureEntry['corners'] } {
  const tNow = currentSandboxTransform;
  const tOld = last.t;
  if (tOld.x === tNow.x && tOld.y === tNow.y && tOld.scale === tNow.scale) {
    return { rect: last.rect, corners: last.corners };
  }
  const k = tNow.scale / tOld.scale;
  const px = (v: number) => (v - tOld.x) * k + tNow.x;
  const py = (v: number) => (v - tOld.y) * k + tNow.y;
  const r = last.rect.rect;
  const c = last.corners.corners;
  return {
    rect: {
      ...last.rect,
      rect: { left: px(r.left), top: py(r.top), width: r.width * k, height: r.height * k },
    },
    corners: {
      ...last.corners,
      corners: {
        TL: { x: px(c.TL.x), y: py(c.TL.y) },
        TR: { x: px(c.TR.x), y: py(c.TR.y) },
        BR: { x: px(c.BR.x), y: py(c.BR.y) },
        BL: { x: px(c.BL.x), y: py(c.BL.y) },
      },
    },
  };
}

/** Shift a re-projected payload by an offscreen section's own screen delta. */
function shiftProjected(
  proj: { rect: MeasureEntry['rect']; corners: MeasureEntry['corners'] },
  d: { dx: number; dy: number },
): { rect: MeasureEntry['rect']; corners: MeasureEntry['corners'] } {
  if (d.dx === 0 && d.dy === 0) return proj;
  const r = proj.rect.rect;
  const c = proj.corners.corners;
  return {
    rect: { ...proj.rect, rect: { left: r.left + d.dx, top: r.top + d.dy, width: r.width, height: r.height } },
    corners: {
      ...proj.corners,
      corners: {
        TL: { x: c.TL.x + d.dx, y: c.TL.y + d.dy },
        TR: { x: c.TR.x + d.dx, y: c.TR.y + d.dy },
        BR: { x: c.BR.x + d.dx, y: c.BR.y + d.dy },
        BL: { x: c.BL.x + d.dx, y: c.BL.y + d.dy },
      },
    },
  };
}

/** `${vpPrefix}:${nodeId}` cache key from an element's id attributes.
 *  Normal element: data-node-id = vpPrefix + data-id (endsWith data-id).
 *  Ghost copy:     data-node-id = vpPrefix + data-id + '__N' — the suffix is
 *  kept in the key so each ghost gets its own entry. */
function elCacheParts(el: Element): { nodeId: string; vpPrefix: string } {
  const fullId = el.getAttribute('data-node-id') || '';
  const dataId = el.getAttribute('data-id') || '';
  if (fullId.endsWith(dataId)) {
    return { nodeId: dataId, vpPrefix: fullId.slice(0, fullId.length - dataId.length) };
  }
  if (dataId) {
    const idx = fullId.lastIndexOf(dataId);
    if (idx >= 0) return { nodeId: fullId.slice(idx), vpPrefix: fullId.slice(0, idx) };
    return { nodeId: dataId, vpPrefix: '' };
  }
  return { nodeId: fullId, vpPrefix: '' };
}

const CACHED_PROPS = [
  'width', 'height', 'left', 'top', 'right', 'bottom', 'transform',
  'display', 'position', 'flex-direction',
  'gap', 'row-gap', 'column-gap',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-radius',
  // Grid template + per-child resolved placement. Needed by
  // `GridDragStrategy` for cell detection during drag. Without
  // these in the cache, `findNodeComputedStyles` returns empty
  // strings (the cache lookup short-circuits the async fallback
  // when any entry exists for the node), so `parseGridInfo`
  // can't see grid tracks and `getCellAtPoint` always bails.
  'grid-template-columns', 'grid-template-rows',
  'grid-column-start', 'grid-column-end',
  'grid-row-start', 'grid-row-end',
];

/** How far past the window an element can sit and still be measured live. */
const OFFSCREEN_MARGIN = 600;

let idleFullTimer: ReturnType<typeof setTimeout> | null = null;

export interface EmitAllMeasuresOptions {
  /** Default true. The idle full pass calls with false to heal staleness. */
  skipOffscreenSections?: boolean;
  /** Re-cull scheduler hook (bridge-sandbox's culling controller). */
  scheduleCullEvaluate?: () => void;
}

export function emitAllMeasures(opts?: EmitAllMeasuresOptions): void {
  if (!contentRoot) return;
  const root = contentRoot;
  const skipOffscreen = opts?.skipOffscreenSections !== false;
  const t0 = performance.now();

  // Force layout so getBoundingClientRect reflects the transform
  void root.offsetHeight;

  // ── Offscreen-section pre-pass: one rect per top-level section ──────────
  const skipDelta = new Map<Element, { dx: number; dy: number }>();
  let sectionsSkipped = 0;
  if (skipOffscreen && typeof window !== 'undefined') {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const M = OFFSCREEN_MARGIN;
    for (const tile of Array.from(root.children)) {
      if (!(tile instanceof HTMLElement)) continue;
      if (tile.hasAttribute('data-culled')) continue; // whole-tile replay handles it
      if (!tile.hasAttribute('data-viewport') && !tile.hasAttribute('data-node-id')) continue;
      for (const sec of Array.from(tile.children)) {
        if (!(sec instanceof HTMLElement) || !sec.hasAttribute('data-node-id')) continue;
        const parts = elCacheParts(sec);
        const last = lastEmittedMeasure.get(`${parts.vpPrefix}:${parts.nodeId}`);
        if (!last) continue; // never measured — measure live this pass
        const r = sec.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue; // not laid out — measure live
        const offscreen = r.right < -M || r.left > vw + M || r.bottom < -M || r.top > vh + M;
        if (!offscreen) continue;
        const proj = reprojectMeasure(last);
        const d = { dx: r.left - proj.rect.rect.left, dy: r.top - proj.rect.rect.top };
        sectionsSkipped++;
        skipDelta.set(sec, d);
        sec.querySelectorAll('[data-node-id]').forEach((desc) => skipDelta.set(desc, d));
      }
    }
  }

  // Precompute membership sets ONCE — the previous per-element
  // `closest('[data-cms-ghost]')` + `closest('[data-culled]')` ancestor
  // walks were a large share of the loop cost on 2–3k-node pages.
  //
  // CMS-bound ghost rows must be invisible to the parent's hit-test path.
  // Pointer-events:none stops native DOM events, but the parent's
  // `getNodeHitsAtPoint` iterates rectCache directly, so any ghost entry
  // here would still register as a click target. Drop them at the source —
  // both the ghost root AND its descendants (children only carry
  // `data-node-id`, not `data-cms-ghost`). Inline-map ghosts (per-item
  // editable) do NOT carry data-cms-ghost — they stay in the cache so users
  // can keep clicking individual rows to edit them.
  const ghostEls = new Set<Element>();
  root.querySelectorAll('[data-cms-ghost="true"]').forEach(g => {
    ghostEls.add(g);
    g.querySelectorAll('[data-node-id]').forEach(d => ghostEls.add(d));
  });
  // A genuinely culled root is `display:none` (CullingController.cull sets both
  // the inline display AND data-culled together). If a `data-culled` root is
  // actually VISIBLE, the attribute is STALE — the node was culled offscreen
  // then re-shown/reparented and its attr never got cleared (evaluate()/
  // restore() are roots-only, so a node re-nested out of the root level is
  // never revisited). Replaying the OLD captured rect for a visible node leaves
  // it "visible but unhittable until I switch pages" (the hit-test reads the
  // stale/zero projected rect): the reparented-child-goes-dead bug. Gate on the
  // inline display (cheap, no forced layout — unlike getBoundingClientRect) so
  // a stale-but-visible root AND its subtree fall through to a LIVE measure.
  const culledEls = new Set<Element>();
  root.querySelectorAll('[data-culled]').forEach(c => {
    if ((c as HTMLElement).style.display !== 'none') return; // stale attr on a visible node → measure live
    culledEls.add(c);
    c.querySelectorAll('[data-node-id]').forEach(d => culledEls.add(d));
  });

  const allRects: Array<{ nodeId: string; vpPrefix: string; rect: { left: number; top: number; width: number; height: number } }> = [];
  const cornersPayload: Array<{ nodeId: string; vpPrefix: string; corners: CornersLike; decoupled: boolean }> = [];
  const computedPayload: Array<{ nodeId: string; vpPrefix: string; styles: Record<string, string> }> = [];
  // Per-pass rotation memo: cornersForElement's ancestor rotation/skew walk
  // is O(depth) getComputedStyle reads per element — shared ancestors make
  // the memoised sweep O(N) instead of O(N × depth).
  const rotMemo = new Map<Element, boolean>();
  let measured = 0;
  let replayedCulled = 0;
  let replayedOffscreen = 0;

  root.querySelectorAll('[data-node-id]').forEach(el => {
    if (ghostEls.has(el)) return;
    const { nodeId, vpPrefix } = elCacheParts(el);
    const cacheKey = `${vpPrefix}:${nodeId}`;
    // CULLED subtree: display:none — measuring would write zeros over
    // valid geometry. Replay the last real payloads instead (exact:
    // nothing moves while culled). First-ever-culled-without-measure
    // has no entry and is simply absent until it materialises.
    if (culledEls.has(el)) {
      const last = lastEmittedMeasure.get(cacheKey);
      if (last) {
        const proj = reprojectMeasure(last);
        allRects.push(proj.rect);
        cornersPayload.push(proj.corners);
        computedPayload.push(last.computed);
        replayedCulled++;
      }
      return;
    }
    // OFFSCREEN SECTION of a visible tile: replay shifted by the section's
    // own delta (see module comment). Entries without a cache record (nodes
    // added while offscreen) stay absent until the idle full pass.
    const d = skipDelta.get(el);
    if (d) {
      const last = lastEmittedMeasure.get(cacheKey);
      if (last) {
        const proj = shiftProjected(reprojectMeasure(last), d);
        allRects.push(proj.rect);
        cornersPayload.push(proj.corners);
        computedPayload.push(last.computed);
        replayedOffscreen++;
      }
      return;
    }
    const r = (el as HTMLElement).getBoundingClientRect();
    allRects.push({ nodeId, vpPrefix, rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
    // Corners use painted bbox for SVG (see `cornersForElement`); rect stays on wrapper.
    cornersPayload.push({ nodeId, vpPrefix, corners: cornersForElement(el, rotMemo), decoupled: cornersAreDecoupled(el) });
    const cs = getComputedStyle(el as HTMLElement);
    const styles: Record<string, string> = {};
    for (const prop of CACHED_PROPS) {
      const val = cs.getPropertyValue(prop);
      if (val) {
        const camel = prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        styles[camel] = val;
      }
    }
    // Synthetic keys: parent's content-box width/height in CSS px.
    // CSS doesn't expose these via getComputedStyle — we have to read
    // `parentElement.clientWidth/clientHeight` directly. The host's
    // `findNodeParentInnerSize` queries these via the same cache that
    // backs `getComputedValues`, so populating them here makes
    // `%`-based unit conversions in SizeTool / PinControl work without
    // a Comlink round-trip on every dropdown change. The `__` prefix
    // marks them as synthetic (no real CSS property starts with __).
    const parent = (el as HTMLElement).parentElement;
    if (parent) {
      styles['__parentClientWidth'] = String(parent.clientWidth);
      styles['__parentClientHeight'] = String(parent.clientHeight);
    }
    // Synthetic: own offset width/height — logical-pixel size that's
    // immune to canvas transforms (unlike getBoundingClientRect, which
    // scales with the contentRoot zoom). Used as a fallback when
    // `getComputedStyle().height` returns 'auto' (parses to NaN). The
    // viewport-height auto→px seed in SizeTool relied on the rect
    // fallback before, which collapsed the viewport to its
    // transformed-pixel height at low zoom.
    styles['__offsetWidth'] = String((el as HTMLElement).offsetWidth);
    styles['__offsetHeight'] = String((el as HTMLElement).offsetHeight);
    // Synthetic: SVG painted bbox in user-space (viewBox) coordinates.
    // Lets the host's shape-edit normalize-on-exit read the bbox
    // SYNCHRONOUSLY from the computed cache instead of going through
    // an async `getBBoxAsync` Comlink round-trip. The async path left
    // a 5–10 ms window where the iframe had committed the new path
    // (post-pointerup) but my wrapper bounds hadn't landed yet, and
    // the user saw the painted shape extending past the still-old
    // wrapper for a frame before the normalize snapped it. Reading
    // here makes the entire normalize cycle one synchronous tick.
    if (el.tagName.toLowerCase() === 'svg' && typeof (el as any).getBBox === 'function') {
      try {
        const b = (el as SVGSVGElement).getBBox();
        styles['__bboxX'] = String(b.x);
        styles['__bboxY'] = String(b.y);
        styles['__bboxWidth'] = String(b.width);
        styles['__bboxHeight'] = String(b.height);
      } catch { /* ignore — element not laid out yet */ }
      // Stable wrapper user→screen affine for the parent-frame drag inverse.
      Object.assign(styles, svgMatrixStyles(el));
    }
    computedPayload.push({ nodeId, vpPrefix, styles });
    measured++;
    lastEmittedMeasure.set(cacheKey, {
      rect: allRects[allRects.length - 1],
      corners: cornersPayload[cornersPayload.length - 1],
      computed: computedPayload[computedPayload.length - 1],
      t: { ...currentSandboxTransform },
    });
  });

  const cr = root.getBoundingClientRect();
  emit({
    type: 'allRects',
    rects: allRects,
    transform: { ...currentSandboxTransform },
    containerRect: { left: cr.left, top: cr.top, width: cr.width, height: cr.height },
    // Echo the render epoch — the host drops allRects from an older render
    // (a pre-switch remeasure landing after the switch's cache wipe).
    renderSeq: currentRenderSeq,
  });
  // Re-cull once the cycle settles (idle-debounced).
  opts?.scheduleCullEvaluate?.();
  // BATCHED corner/computed emits: one message per kind instead of one per
  // node — thousands of individual postMessages (structured-clone each) were
  // the dominant cost of this pass once the offscreen replay removed the
  // measuring itself.
  if (cornersPayload.length) emit({ type: 'cornersUpdateBatch', transform: { ...currentSandboxTransform }, entries: cornersPayload });
  if (computedPayload.length) emit({ type: 'computedUpdateBatch', entries: computedPayload });

  trace.action('sandbox:allRects-measure', {
    measured, replayedCulled, replayedOffscreen, sectionsSkipped,
    fullPass: !skipOffscreen, ms: Math.round(performance.now() - t0),
  });

  // Idle full pass — heals whatever the section skip allowed to go stale
  // (internal edits to offscreen sections, nodes added while offscreen).
  if (sectionsSkipped > 0) {
    if (idleFullTimer) clearTimeout(idleFullTimer);
    idleFullTimer = setTimeout(() => {
      idleFullTimer = null;
      emitAllMeasures({ ...opts, skipOffscreenSections: false });
    }, 400);
  }
}
