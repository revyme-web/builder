// culling-controller.ts — standard VIEWPORT CULLING for the editor canvas.
//
// Root-level subtrees (viewport artboards + root canvas nodes) that sit
// COMPLETELY outside the visible screen are swapped for a lightweight grey
// placeholder: the real subtree goes display:none (out of style/layout/paint)
// and a single absolutely-positioned div holds its exact box. When the camera
// settles (pan/zoom idle) with a culled root back in view, it re-materialises.
//
// Contracts that keep the rest of the editor correct:
//   • restoreAll() runs at the START of every render cycle (bridge-sandbox
//     render()), so DOM patches AND the allRects measurement always operate
//     on REAL, laid-out DOM — the parent's rect caches never see culled
//     geometry and stay valid while culled (nothing moves offscreen).
//   • Materialisation happens only at gesture END (idle debounce) — panning
//     across a culled root shows the grey box until the camera stops, which
//     keeps the gesture itself free of layout bursts.
//   • Hysteresis: culling needs the root fully past viewport+CULL_MARGIN,
//     restoring needs it within viewport+RESTORE_MARGIN — no thrash at edges.
//   • A defer predicate (dnd interacting) suspends evaluation during drags:
//     edge-autopan moves the camera mid-drag and must not swap DOM under the
//     drag strategy's feet. The gesture-end reconcile re-schedules us.
//
// CANVAS-ONLY by construction: this module renders nothing on the live site.

import { trace } from '@/shared/debug-trace';

const IDLE_MS = 140;
/** Max culled roots re-materialised per frame when a big camera jump brings
 *  many back at once — see the staggered branch in evaluate(). */
const RESTORE_CHUNK = 4;
const CULL_MARGIN_SCREEN_PX = 200;
const RESTORE_MARGIN_SCREEN_PX = 100;

interface Box { left: number; top: number; width: number; height: number }

/** A culled entry knows the parent it is expected to hang off, because
 *  `restoreReNested` treats "moved elsewhere" as staleness. Root entries expect
 *  the container; IN-VIEWPORT entries expect whatever held them when culled. */
interface CullMeta {
  /** Null for in-viewport culls — see `cullInViewport` in evaluate(). */
  placeholder: HTMLElement | null;
  prevDisplay: string;
  box: Box;
  parent: HTMLElement;
}

/** Cullable = an element we can hide and read a box from. NOT `instanceof
 *  HTMLElement`: shape nodes are built with `createElementNS` (Renderer.ts,
 *  cast `as unknown as HTMLElement` — a compile-time lie), so at RUNTIME an
 *  `<svg>` is an SVGElement and fails that check. Every root-level SVG shape was
 *  therefore invisible to culling while its `<div>` siblings culled normally —
 *  a page built from shapes paid full style/layout/paint for every offscreen
 *  one (user report 2026-08-04). `.style` is what we actually need, and both
 *  branches of the DOM hierarchy have it. */
function isCullable(el: Element): el is HTMLElement {
  return el instanceof Element && 'style' in el;
}

/** `offsetLeft`/`offsetWidth` are HTMLElement-only — an SVG shape reaching the
 *  degenerate-box fallback would produce a box of `undefined`s, which compares
 *  false against every bound and silently culls or spares at random. */
function offsetBox(el: HTMLElement): Box {
  return {
    left: el.offsetLeft ?? 0, top: el.offsetTop ?? 0,
    width: el.offsetWidth ?? 0, height: el.offsetHeight ?? 0,
  };
}

export class CullingController {
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private t = { x: 0, y: 0, scale: 1 };
  private culled = new Map<HTMLElement, CullMeta>();

  constructor(
    private container: HTMLElement,
    /** Return true to postpone evaluation (e.g. while a drag is live). */
    private defer: () => boolean = () => false,
    /** Fired after an evaluate() that changed anything — (culled, restored).
     *  bridge-sandbox uses restored>0 to schedule a rect remeasure so the
     *  parent caches pick up the re-materialised subtrees without waiting
     *  for the next render cycle. */
    private onChange?: (culled: number, restored: number) => void,
  ) {}

  onTransform(x: number, y: number, scale: number): void {
    this.t = { x, y, scale };
    this.schedule(IDLE_MS);
  }

  /** Re-evaluate soon — used after render cycles and gesture ends. */
  scheduleEvaluate(): void {
    this.schedule(IDLE_MS * 2);
  }

  private schedule(ms: number): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.defer()) { this.schedule(IDLE_MS * 2); return; }
      this.evaluate();
    }, ms);
  }

  /** Put every culled root back — MUST run before renders/measures so they
   *  hit real DOM. Cheap no-op when nothing is culled. */
  restoreAll(): void {
    if (this.culled.size === 0) return;
    const n = this.culled.size;
    for (const [el, meta] of this.culled) {
      meta.placeholder?.remove();
      el.style.display = meta.prevDisplay;
      el.removeAttribute('data-culled');
    }
    this.culled.clear();
    trace.dom('culling.restoreAll', { count: n });
  }

  /** Render-cycle maintenance that KEEPS offscreen roots culled. Patching a
   *  display:none subtree is nearly free (no style/layout/paint), and the
   *  allRects pass replays `lastEmittedMeasure` for `[data-culled]` content —
   *  so renders don't need real DOM for culled roots. The old restoreAll()
   *  before every render re-materialized EVERYTHING on each edit, forcing a
   *  full multi-tile relayout exactly during drags/undo/reparent (live find
   *  2026-07-17: culling gave no edit-time win on an 11k-px page). Only
   *  entries whose element left the DOM (file switch, stale-viewport cleanup)
   *  are dropped, with their placeholders removed. */
  /** Restore culled roots whose content was PATCHED while hidden (the
   *  Renderer marks them `data-culled-dirty`). A patched-hidden root's
   *  placeholder box and replayed rect caches are stale — the grey skeleton
   *  and the node name labels bleed at the OLD position (live find
   *  2026-07-17). Restoring before the measure pass refreshes real geometry;
   *  the next idle evaluate re-culls with the fresh box. */
  restoreDirty(): void {
    if (this.culled.size === 0) return;
    let restored = 0;
    for (const [el] of this.culled) {
      if (el.hasAttribute('data-culled-dirty')) {
        el.removeAttribute('data-culled-dirty');
        this.restore(el);
        restored++;
      }
    }
    if (restored > 0) {
      trace.dom('culling.restoreDirty', { restored, remaining: this.culled.size });
      this.schedule(IDLE_MS);
    }
  }

  /** Restore culled entries whose element is still CONNECTED but was reparented
   *  OUT of the content root — a canvas node dragged (or layers-panel re-nested)
   *  INTO a frame, so it is no longer a direct child of the container. Such an
   *  entry is stale: a culled entry only makes sense for a cullable ROOT, and
   *  evaluate()/restore() iterate roots() ONLY, so once the element is nested
   *  they can NEVER reach it again. Left alone it stays display:none +
   *  data-culled forever — visible-as-nothing, unhittable, "like it doesn't
   *  exist," until a page switch tears the controller down (the
   *  reparented-child-vanishes bug). Restore to prevDisplay (the element's own
   *  display is unaffected by its new parent) so the render's patch + the
   *  measure pass treat it as the normal child it now is — real geometry, no
   *  stale placeholder, no projected rect.
   *
   *  Called from BOTH the pre-render prune (catches a canvas drag, whose
   *  reparentLive moves the DOM BEFORE the commit render) AND the post-render
   *  evaluate (catches a layers-panel re-nest, whose `move` mutation reparents
   *  the DOM INSIDE renderNodes — after the prune already ran). One of the two
   *  always sees the element already re-homed, so the orphan never survives a
   *  single render cycle. */
  private restoreReNested(): number {
    if (this.culled.size === 0) return 0;
    let restored = 0;
    for (const [el, meta] of this.culled) {
      // `meta.parent`, NOT the container: an in-viewport entry legitimately
      // hangs off its artboard, and comparing against the container would
      // restore every one of them on every render cycle — culling that undoes
      // itself before it can save anything.
      if (el.isConnected && el.parentElement !== meta.parent) {
        this.restore(el);
        restored++;
      }
    }
    if (restored > 0) trace.dom('culling.restoreReNested', { restored, remaining: this.culled.size });
    return restored;
  }

  /** Drop culled entries that are no longer valid + restore their elements.
   *  Runs every render cycle (BEFORE the render patches). Handles:
   *   - RE-NESTED (still connected, left root level) → restore (see
   *     restoreReNested); catches the canvas-drag path here.
   *   - DISCONNECTED (left the DOM: file switch, stale-viewport cleanup) → drop
   *     the entry, clearing the cull styling too so if the SAME element
   *     re-attaches later a lingering inline display:none doesn't hide it. */
  pruneStale(): void {
    if (this.culled.size === 0) return;
    this.restoreReNested();
    let pruned = 0;
    for (const [el, meta] of this.culled) {
      if (!el.isConnected) {
        meta.placeholder?.remove();
        el.style.display = meta.prevDisplay;
        el.removeAttribute('data-culled');
        this.culled.delete(el);
        pruned++;
      }
    }
    if (pruned > 0) trace.dom('culling.pruneStale', { pruned, remaining: this.culled.size });
  }

  /** Root-level content subtrees: viewport artboards + root canvas nodes.
   *  Placeholders/style/hoisted containers are excluded. */
  private roots(): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const el of Array.from(this.container.children)) {
      if (!isCullable(el)) continue;
      if (el.hasAttribute('data-culling-placeholder')) continue;
      if (el.hasAttribute('data-canvas-styles') || el.hasAttribute('data-hoisted-canvas')) continue;
      // OVERLAY PORTAL — never a culling candidate. It's a zero-HEIGHT
      // positioning container pinned at its viewport's top-left, whose children
      // are absolutely placed at arbitrary offsets down the page (an overlay
      // hanging off a trigger 5000px down still lives in a portal whose own box
      // is a sliver at y=0). It carries `data-viewport` for click-viewport
      // detection, which used to make `roots()` treat it as a content root and
      // `boxOf()` take the viewport branch — returning that zero-height sliver
      // instead of unioning the children. Scroll far enough down a tall page and
      // the sliver leaves the screen, so the portal got display:none'd and EVERY
      // overlay in that viewport vanished — visible only as the overlay-mode
      // tint, with a stale selection rect that no longer tracked zoom. Short
      // pages never reproduced it: their sliver is always on screen. Live find
      // 2026-07-25. Culling it saves nothing anyway — it holds a handful of
      // small elements and no layout of its own.
      if (el.hasAttribute('data-overlay-portal')) continue;
      if (el.hasAttribute('data-viewport') || el.hasAttribute('data-node-id')) out.push(el);
    }
    return out;
  }

  /** Cullable nodes INSIDE a live viewport artboard.
   *
   *  `roots()` is root-level only, so an artboard is one all-or-nothing unit:
   *  a page whose content is 900 shapes spread across 20,000px pays for every
   *  one of them as long as any sliver of the artboard is on screen. That is
   *  the "why aren't these culled?" case — nothing was broken, the granularity
   *  simply stopped at the tile.
   *
   *  ABSOLUTELY-POSITIONED ONLY, and read from the INLINE style:
   *   · `display:none` on an in-flow child would collapse the layout and shove
   *     every sibling — catastrophic, and invisible until the user pans back.
   *     An out-of-flow child affects nobody else's geometry, which is the same
   *     property that makes root-level culling safe.
   *   · inline (not computed) because this runs over every node on the page:
   *     `getComputedStyle` here would be a forced-layout storm at exactly the
   *     moment we're trying to save work. A replica whose `position` comes from
   *     an `@container` rule just isn't a candidate — it stays alive, which is
   *     the safe direction to be wrong in.
   *
   *  Descendants of an already-culled candidate are skipped: their ancestor is
   *  `display:none`, so culling them buys nothing and doubles the bookkeeping. */
  private inViewportCandidates(liveRoots: HTMLElement[]): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const root of liveRoots) {
      if (!root.hasAttribute('data-viewport')) continue;   // canvas-node roots union their subtree already
      for (const raw of Array.from(root.querySelectorAll('[data-node-id]'))) {
        if (!isCullable(raw)) continue;
        const pos = raw.style.position;
        if (pos !== 'absolute' && pos !== 'fixed') continue;
        if (raw.hasAttribute('data-culling-placeholder')) continue;
        // An overlay lives in the portal, whose own box doesn't bound it —
        // same reasoning as the portal exemption in roots().
        if (raw.hasAttribute('data-overlay-node')) continue;
        if (raw.parentElement?.closest('[data-culled]')) continue;
        out.push(raw);
      }
    }
    return out;
  }

  /** Canvas-space box. Roots are absolutely-positioned children of the
   *  transformed content root, so offset* IS canvas space. A culled root is
   *  display:none — use the box CAPTURED at cull time (nothing moves while
   *  culled; renders restore first), which also avoids forced-layout reads. */
  private boxOf(el: HTMLElement): Box {
    const meta = this.culled.get(el);
    if (meta) return meta.box;
    // Viewport tiles clip/contain their content — their own box IS the
    // visual bounds.
    if (el.hasAttribute('data-viewport')) {
      return offsetBox(el);
    }
    // Canvas-node roots can have absolutely-positioned children far OUTSIDE
    // their own box (overflow visible). Culling by the root box alone hides
    // visually-in-view children with the placeholder sitting offscreen at the
    // root — the "selected frame is invisible until I zoom out" bug (live
    // find 2026-07-17). Union the subtree's client rects and convert
    // screen → canvas space with the current transform.
    const { x, y, scale } = this.t;
    const r = el.getBoundingClientRect();
    let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
    for (const child of Array.from(el.querySelectorAll('[data-node-id]'))) {
      const cr = (child as HTMLElement).getBoundingClientRect();
      if (cr.width === 0 && cr.height === 0) continue;
      if (cr.left < left) left = cr.left;
      if (cr.top < top) top = cr.top;
      if (cr.right > right) right = cr.right;
      if (cr.bottom > bottom) bottom = cr.bottom;
    }
    // Degenerate union (jsdom / not-laid-out) — fall back to the offset box.
    if (!(scale > 0) || (right - left === 0 && bottom - top === 0)) {
      return offsetBox(el);
    }
    return {
      left: (left - x) / scale,
      top: (top - y) / scale,
      width: (right - left) / scale,
      height: (bottom - top) / scale,
    };
  }

  evaluate(): void {
    // Post-render safety, TWO cases the pre-render prune can't see because the
    // render itself changes the DOM between the two passes (line-order in
    // bridge-sandbox: prune → render → evaluate):
    //  - a layers-panel re-nest moves a culled element INSIDE the render →
    //    restore it (roots-only logic below can never reach a nested element);
    //  - a FILE SWITCH: the render's removal sweep just deleted the old page's
    //    elements, so their culled entries are now DISCONNECTED — without
    //    dropping them here their grey placeholders survive onto the new page
    //    (and a blank page never renders again to clean them: the "culling
    //    artifacts + stale placeholders after switching pages" bug).
    // pruneStale handles both (restoreReNested + disconnected drop). Runs
    // before the scale guard so it fires even on a not-yet-measured frame.
    this.pruneStale();
    const { x, y, scale } = this.t;
    if (!(scale > 0)) return;
    const vis = {
      left: -x / scale,
      top: -y / scale,
      right: (window.innerWidth - x) / scale,
      bottom: (window.innerHeight - y) / scale,
    };
    let culledN = 0;
    const toRestore: HTMLElement[] = [];
    /** Shared cull/restore decision. `placeholder` distinguishes a root (grey
     *  box marks where the artboard is) from an in-viewport node (no marker —
     *  it is offscreen by definition, and one div per hidden shape would spend
     *  back exactly what culling just saved). */
    const consider = (el: HTMLElement, placeholder: boolean): void => {
      const isCulled = this.culled.has(el);
      const b = this.boxOf(el);
      if (b.width === 0 && b.height === 0) return; // unmeasurable — never touch
      const pad = (isCulled ? RESTORE_MARGIN_SCREEN_PX : CULL_MARGIN_SCREEN_PX) / scale;
      const outside =
        b.left + b.width < vis.left - pad || b.left > vis.right + pad ||
        b.top + b.height < vis.top - pad || b.top > vis.bottom + pad;
      if (outside && !isCulled) {
        this.cull(el, b, placeholder);
        culledN++;
        // INVARIANT: a culled entry is either a root, or a node inside a LIVE
        // root. When a whole artboard goes, its in-viewport entries are
        // redundant (an ancestor is display:none) — and worse, stranded: the
        // candidate sweep only walks live roots, so nothing would ever restore
        // them. Drop them now and let the next evaluate re-cull whatever is
        // still offscreen once the artboard is back.
        if (placeholder) this.releaseCulledInside(el);
      } else if (!outside && isCulled) toRestore.push(el);
    };

    const roots = this.roots();
    for (const el of roots) consider(el, true);
    // Then INSIDE the artboards that survived — a live tile is one cullable
    // unit at root level, but its own contents can still be mostly offscreen.
    for (const el of this.inViewportCandidates(roots.filter(r => !this.culled.has(r)))) {
      consider(el, false);
    }
    // SMALL restore sets materialise synchronously (the common pan case).
    // BIG sets — a large zoom-out bringing dozens of culled tiles back into
    // view at once — are STAGGERED across frames: restoring everything in
    // one pass forces a massive style/layout/paint + a GPU re-raster of the
    // whole content at the new scale in a single frame, which saturated the
    // shared GPU process and left the PARENT editor chrome (left menu /
    // properties panel) checkerboarding grey until the raster caught up
    // (live find 2026-07-19). A few tiles per frame keeps each frame's
    // paint bounded; the remeasure fires once after the LAST chunk.
    if (toRestore.length <= RESTORE_CHUNK) {
      for (const el of toRestore) this.restore(el);
      if (culledN || toRestore.length) {
        trace.dom('culling.evaluate', { culled: culledN, restored: toRestore.length, active: this.culled.size });
        this.onChange?.(culledN, toRestore.length);
      }
    } else {
      trace.dom('culling.evaluate-staggered', { culled: culledN, toRestore: toRestore.length, chunk: RESTORE_CHUNK });
      if (culledN) this.onChange?.(culledN, 0);
      const queue = toRestore;
      let restoredTotal = 0;
      const step = () => {
        // Entries restored elsewhere in the meantime (restoreAll before a
        // render, a newer evaluate) no-op harmlessly — restore() bails when
        // the element is no longer in the culled map.
        for (let i = 0; i < RESTORE_CHUNK && queue.length > 0; i++) {
          const el = queue.shift()!;
          if (this.culled.has(el)) { this.restore(el); restoredTotal++; }
        }
        if (queue.length > 0) { requestAnimationFrame(step); return; }
        trace.dom('culling.evaluate-staggered-done', { restored: restoredTotal, active: this.culled.size });
        if (restoredTotal > 0) this.onChange?.(0, restoredTotal);
      };
      requestAnimationFrame(step);
    }
  }

  /** Restore every culled entry nested inside `root` — see the invariant note
   *  at the cull site. Skips `root` itself. */
  private releaseCulledInside(root: HTMLElement): void {
    let released = 0;
    for (const [el] of this.culled) {
      if (el !== root && root.contains(el)) { this.restore(el); released++; }
    }
    if (released > 0) trace.dom('culling.releaseCulledInside', { released, remaining: this.culled.size });
  }

  private cull(el: HTMLElement, b: Box, placeholder = true): void {
    let ph: HTMLElement | null = null;
    if (placeholder) {
      ph = document.createElement('div');
      ph.setAttribute('data-culling-placeholder',
        el.getAttribute('data-viewport') || el.getAttribute('data-node-id') || 'root');
      ph.style.cssText =
        `position:absolute;left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;` +
        'background:rgba(128, 128, 140, 0.10);border:1px solid rgba(128, 128, 140, 0.25);' +
        'border-radius:6px;pointer-events:none;box-sizing:border-box;';
      this.container.insertBefore(ph, el);
    }
    this.culled.set(el, {
      placeholder: ph,
      prevDisplay: el.style.display,
      box: b,
      // Where this element belongs. `restoreReNested` reads it rather than
      // assuming the container, which every in-viewport entry would fail.
      parent: el.parentElement ?? this.container,
    });
    el.style.display = 'none';
    el.setAttribute('data-culled', 'true');
  }

  private restore(el: HTMLElement): void {
    const meta = this.culled.get(el);
    if (!meta) return;
    meta.placeholder?.remove();
    el.style.display = meta.prevDisplay;
    el.removeAttribute('data-culled');
    this.culled.delete(el);
  }
}
