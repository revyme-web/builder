// style-handlers.ts — imperative style / attribute / CSS patching handlers
// for the sandbox API. Extracted verbatim from bridge-sandbox.ts (Phase 7
// split); bridge-sandbox assembles these into the `api` dispatch table.

import type { PatchUpdate } from '../sandbox-api';
import { clearPatchKeyChain, trackImperativeStyleKeys } from '@/canvas/Renderer';
import { trace } from '@/shared/debug-trace';
import { applyStrokeAlignment } from '@/canvas/renderer/style-apply';
import { resolveResponsiveUnits, getResponsiveVpWidth } from '@/shared/responsive-units';
import { coerceCssNumberToPx, toKebab } from '@/shared/css-utils';
import { findElByNodeId, findAllByNodeId } from '../sandbox-dom-utils';
import { syncEditorFromLiveSvg as syncShapeEditorFromLiveSvg } from '../shape-edit-host';
import { contentRoot, emit } from './sandbox-state';
import { cornersForElement, shouldRefreshSubtree, emitSubtreeRefresh, emitElementRefresh, cornersAreDecoupled } from './rect-emit';
import { isSandboxDndInteracting } from '../sandbox-dnd-host';

/** Two-pass style application — clear empty values first, then set non-empty.
 *  Mirrors `applyStylesToEl` in node-ops.ts. Order matters because clearing a
 *  longhand AFTER setting its shorthand wipes the shorthand too in Chrome —
 *  e.g. setting `borderRadius` then clearing `borderTopLeftRadius` deletes
 *  the radius entirely. Two-pass clears longhands first, so the shorthand
 *  set in pass 2 survives. */
export function applyTwoPass(el: HTMLElement, styles: Record<string, string>, important: boolean, markResidue: boolean = important): void {
  // Imperative write ⇒ this element no longer matches its last-rendered
  // signature. Invalidate the subtree-skip keys up the ancestor chain so the
  // next full render re-patches this branch (render-restore semantics).
  clearPatchKeyChain(el);
  // …and register the keys with the render's stale-clear tracker. Without this
  // an imperative write that ADDS a property is invisible to the renderer (the
  // write arms the render skip, so no render ever records the key), and nothing
  // clears it when the model later drops it — the ⌘Z-after-padding bug.
  trackImperativeStyleKeys(el, Object.keys(styles));
  // Resolve vw/vh per-viewport before writing — CSS would resolve them
  // against the iframe window otherwise, so primary→replica fan-out
  // (e.g. font-size slider drag) would land the same px on every
  // replica until the next full render. See `shared/responsive-units.ts`.
  const vpWidthPx = getResponsiveVpWidth(el);
  const entries = Object.entries(styles);
  // Pass 1: clear
  for (const [key, value] of entries) {
    if (value === '') {
      // Custom properties (`--x`) need removeProperty — bracket assignment is a no-op.
      try { if (key.startsWith('--')) el.style.removeProperty(key); else (el.style as any)[key] = ''; } catch { /* skip */ }
      if (!key.startsWith('--')) untrackLiveImportant(el, toKebab(key));
    }
  }
  // Pass 2: set
  for (const [key, value] of entries) {
    if (value === '') continue;
    // Coerce a bare-number value to px for px-properties (matches the Renderer + React) so a raw-number
    // variable (`gap = 61`) updates LIVE during a slider drag, not just on the commit re-render.
    const resolved = coerceCssNumberToPx(key, resolveResponsiveUnits(value, vpWidthPx));
    try {
      if (key.startsWith('--')) {
        // CSS custom property — MUST use setProperty (e.g. an overlay-border
        // variable's `--X` that the `::after` consumes via `var(--X)`). Bracket
        // assignment silently no-ops, so the live drag wouldn't update the overlay.
        el.style.setProperty(key, resolved, important ? 'important' : '');
      } else if (important) {
        const kebab = toKebab(key);
        el.style.setProperty(kebab, resolved, 'important');
        // MARK the residue: a live-scrub !important patch (or ANY patch onto
        // a REPLICA element — its committed value lives in the @container
        // rule, not node.styles) isn't cleared by the commit: the render is
        // skipped for replica commits, so the inline lingers — invisible
        // while the rule carries the same value, but an UNDO that REMOVES
        // the rule left the stale inline winning until a page switch
        // ("Cmd+Z doesn't update the DOM", 2026-07-21). Every renderNodes
        // pass sweeps [data-live-important] props first + invalidates the
        // patch-skip chain so node styles + rebuilt CSS re-assert.
        trackLiveImportant(el, kebab);
      } else {
        (el.style as any)[key] = resolved;
        if (markResidue) trackLiveImportant(el, toKebab(key));
        else untrackLiveImportant(el, toKebab(key));
      }
    } catch { /* skip */ }
  }
}

/** Comma-set of kebab props this element carries as LIVE !important inline
 *  patches. renderNodes clears them (and the attr) at the start of every
 *  pass so node styles + @container rules re-assert after undo/redo. */
export function trackLiveImportant(el: HTMLElement, kebab: string): void {
  const cur = el.getAttribute('data-live-important');
  const set = new Set(cur ? cur.split(',') : []);
  if (!set.has(kebab)) {
    set.add(kebab);
    el.setAttribute('data-live-important', Array.from(set).join(','));
  }
}

export function untrackLiveImportant(el: HTMLElement, kebab: string): void {
  const cur = el.getAttribute('data-live-important');
  if (!cur) return;
  const set = new Set(cur.split(','));
  if (!set.delete(kebab)) return;
  if (set.size === 0) el.removeAttribute('data-live-important');
  else el.setAttribute('data-live-important', Array.from(set).join(','));
}

  /** Hide/show the DOM-only ghost copies of a CMS collection list while one of
   *  its items is being layout-dragged — so the user drags a single clean item
   *  instead of the full repeated list.
   *
   *  Uses `display:none !important` via a STYLESHEET RULE (not inline) for two
   *  reasons: (1) `display:none` collapses the ghosts OUT OF FLOW so the parent
   *  shrinks to just the dragged item ("as if they're not in the DOM"), and
   *  (2) a rule survives the collection handler's `ghostEl.style.cssText =
   *  template.cssText` re-sync that can fire mid-drag — an inline `display:none`
   *  would get wiped by that, an `!important` rule wins over the non-important
   *  inline display the cssText copy restores. Cleared on drag end. */
export function setCollectionGhostsHidden(containerId: string, vpPrefix: string, hidden: boolean): void {
    if (!contentRoot) return;
    const STYLE_ID = 'collection-ghost-hide-style';
    let styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (hidden) {
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = STYLE_ID;
        document.head.appendChild(styleEl);
      }
      styleEl.textContent = `[data-node-id="${vpPrefix}${containerId}"] > [data-collection-ghost] { display: none !important; }`;
    } else if (styleEl) {
      styleEl.textContent = '';
    }
    trace.action('sandbox:collection-ghosts-hidden', { containerId, vpPrefix, hidden });
}

export function patchStyles(nodeId: string, vpPrefix: string, styles: Record<string, string>, important: boolean): void {
    if (!contentRoot) return;
    // Stale-element guard: during a live re-parent (canvas → frame entry,
    // frame → canvas exit), a duplicate may briefly exist. The OLD element
    // typically still has data-canvas-node="true" from before the move and
    // is no longer the authoritative rendered version. Find candidates with
    // matching data-node-id, remove any that have data-canvas-node="true"
    // but should NOT be canvas-rooted (i.e. when more than one match exists,
    // the non-canvas-node one is authoritative). Then patch the survivor.
    const all = findAllByNodeId(contentRoot, vpPrefix, nodeId);
    if (all.length === 0) return;
    if (all.length > 1) {
      // Multiple matches → remove any STALE ones. A stale match here is a
      // duplicate at a different DOM depth than the others. The deepest
      // (most-nested) is the authoritative rendered position from the
      // latest render; shallower duplicates are leftovers from a prior
      // render that the cleanup loop missed (e.g. a canvas-root element
      // that should've been removed when its node became nested).
      // Compute depth as ancestor count.
      const withDepth = all.map(el => {
        let d = 0; let p: HTMLElement | null = el.parentElement;
        while (p && p !== contentRoot) { d++; p = p.parentElement; }
        return { el, d };
      });
      withDepth.sort((a, b) => b.d - a.d);
      const keep = withDepth[0].el;
      for (const { el } of withDepth.slice(1)) el.remove();
      // Patch only the kept element below.
      const elsToPatch = [keep];
      for (const el of elsToPatch) {
        applyTwoPass(el, styles, important, important || vpPrefix !== '');
      }
      const r = keep.getBoundingClientRect();
      emit({ type: 'rectUpdate', nodeId, vpPrefix, rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
      const cs = getComputedStyle(keep);
      const computedUpdates: Record<string, string> = {};
      for (const key of Object.keys(styles)) {
        const kebab = toKebab(key);
        computedUpdates[key] = cs.getPropertyValue(kebab);
      }
      emit({ type: 'computedUpdate', nodeId, vpPrefix, styles: computedUpdates });
      emit({ type: 'cornersUpdate', nodeId, vpPrefix, corners: cornersForElement(keep), decoupled: cornersAreDecoupled(keep) });
      return;
    }
    const el = all[0];
    applyTwoPass(el, styles, important, important || vpPrefix !== '');
    // .map() ghost mirroring: ghosts share data-id with the template but
    // their data-node-id has a `__N` suffix. Style writes for canonical ids
    // need to apply to every ghost sibling too so the user gets smooth
    // visual feedback (slider drags, color picker, etc.) on the selected
    // ghost — without this, the patch only hits the template, the ghost
    // stays stale until mouseup re-renders. Skip if nodeId already has a
    // ghost suffix (caller targeted a specific ghost) — apply only to
    // exact match in that case.
    const isCanonicalNodeId = !/__\d+$/.test(nodeId);
    if (isCanonicalNodeId) {
      const ghostSiblings = Array.from(
        contentRoot.querySelectorAll<HTMLElement>(`[data-node-id^="${vpPrefix}${nodeId}__"]`),
      ).filter(g => g.getAttribute('data-id') === nodeId);
      for (const ghost of ghostSiblings) {
        applyTwoPass(ghost, styles, important);
      }
    }
    // Emit fresh rect / computed / corners so parent caches stay correct during drag/resize
    const r = el.getBoundingClientRect();
    emit({ type: 'rectUpdate', nodeId, vpPrefix, rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
    const cs = getComputedStyle(el);
    const computedUpdates: Record<string, string> = {};
    for (const key of Object.keys(styles)) {
      const kebab = toKebab(key);
      computedUpdates[key] = cs.getPropertyValue(kebab);
    }
    emit({ type: 'computedUpdate', nodeId, vpPrefix, styles: computedUpdates });
    emit({ type: 'cornersUpdate', nodeId, vpPrefix, corners: cornersForElement(el), decoupled: cornersAreDecoupled(el) });
    // Subtree refresh — fires for any layout-affecting prop, not just
    // `transform`. See `SUBTREE_REFRESH_PROPS` above for the list and
    // rationale. Skipped for cosmetic-only patches (background-color,
    // border-radius, opacity, …) so the cheap drag paths stay cheap.
    if (shouldRefreshSubtree(styles)) {
      if (isSandboxDndInteracting()) emitElementRefresh(el, emit);
      else emitSubtreeRefresh(subtreeRefreshScope(el), emit);
    }
}

/** Refresh scope for a layout-affecting patch: the element's LAYOUT PARENT
 *  when it has one — a flow-affecting change (position flip, size, order,
 *  margin…) re-flows the SIBLINGS, and refreshing only the patched
 *  element's own subtree left sibling rects stale (un-hoverable moved
 *  sibling until a camera re-measure — live find 2026-07-19). Falls back
 *  to the element itself at the content-root level. */
function subtreeRefreshScope(el: HTMLElement): HTMLElement {
  const parentNode = el.parentElement?.closest?.('[data-node-id]') as HTMLElement | null;
  return parentNode ?? el;
}

export function patchMultipleStyles(updates: PatchUpdate[]): void {
    if (!contentRoot) return;
    for (const update of updates) {
      // Same duplicate-element guard as patchStyles — see comment there.
      const els = findAllByNodeId<Element>(contentRoot, update.vpPrefix, update.nodeId);
      if (els.length === 0) continue;
      for (const elNode of Array.from(els)) {
        // Same residue rule as the single patchStyles path: replica-target
        // patches must be MARKED even when non-important — the batched
        // fan-out was the unmarked gap that kept a replica's inline stale
        // through undo (tablet Fill badge, live find 2026-07-21).
        applyTwoPass(elNode as HTMLElement, update.styles, update.important, update.important || update.vpPrefix !== '');
      }
      // Mirror to ghost siblings inside this viewport — same logic as the
      // single-update patchStyles path. Without this, the batched fan-out
      // (used by drag/resize/slider on the primary side) applies styles
      // to each viewport's template but leaves every viewport's ghost
      // copies stale until mouseup forces a full rebuild. The resize
      // looked smooth on the row-zero template but ghosts only updated
      // after release. Symmetric fix.
      const isCanonicalNodeId = !/__\d+$/.test(update.nodeId);
      if (isCanonicalNodeId) {
        const ghostSiblings = Array.from(
          contentRoot.querySelectorAll<HTMLElement>(`[data-node-id^="${update.vpPrefix}${update.nodeId}__"]`),
        ).filter(g => g.getAttribute('data-id') === update.nodeId);
        for (const ghost of ghostSiblings) {
          applyTwoPass(ghost, update.styles, update.important, update.important || update.vpPrefix !== '');
        }
      }
      // Emit fresh rect / computed / corners for the patched element so
      // the parent's caches stay correct during continuous drags
      // (gap, padding, margin, anything that re-layouts the box). The
      // single-call patchStyles path emits these after each apply
      // (lines ~340-348 above); without the symmetric emit here every
      // batched fan-out — used the moment a primary has any replica
      // siblings in rectCache — leaves the cornersCache holding the
      // pre-patch corners. The InteractionOutline / SelectionBorder
      // RAF poll then reads stale corners and the outline lags behind
      // the actual element until mouseup forces a full re-render.
      // Same per-element scope as patchStyles — no `allRects` reset.
      const primary = els[0] as HTMLElement;
      const r = primary.getBoundingClientRect();
      emit({
        type: 'rectUpdate',
        nodeId: update.nodeId,
        vpPrefix: update.vpPrefix,
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      });
      const cs = getComputedStyle(primary);
      const computedUpdates: Record<string, string> = {};
      for (const key of Object.keys(update.styles)) {
        const kebab = toKebab(key);
        computedUpdates[key] = cs.getPropertyValue(kebab);
      }
      emit({
        type: 'computedUpdate',
        nodeId: update.nodeId,
        vpPrefix: update.vpPrefix,
        styles: computedUpdates,
      });
      emit({
        type: 'cornersUpdate',
        nodeId: update.nodeId,
        vpPrefix: update.vpPrefix,
        corners: cornersForElement(primary),
        decoupled: cornersAreDecoupled(primary),
      });
      // Same subtree refresh as the single-call patchStyles path —
      // descendants get fresh rect/corners when the patched parent's
      // styles re-layout them (gap on a flex/grid container, padding
      // on an auto-sized box, transform on a viewport root, etc.).
      if (shouldRefreshSubtree(update.styles)) {
        if (isSandboxDndInteracting()) emitElementRefresh(primary, emit);
        else emitSubtreeRefresh(subtreeRefreshScope(primary), emit);
      }
    }
}

export function injectCSS(selector: string, cssBody: string): void {
    if (!contentRoot) return;
    let styleEl = contentRoot.querySelector('[data-canvas-styles]') as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.setAttribute('data-canvas-styles', 'true');
      contentRoot.prepend(styleEl);
    }
    const current = styleEl.textContent || '';
    const selectorEscaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ruleRegex = new RegExp(`${selectorEscaped}\\s*\\{[^}]*\\}`, 'g');
    const newRule = `${selector} { ${cssBody} }`;
    if (ruleRegex.test(current)) {
      styleEl.textContent = current.replace(ruleRegex, newRule);
    } else {
      styleEl.textContent = current + '\n' + newRule;
    }
}

export function removeCSS(selector: string): void {
    if (!contentRoot) return;
    const styleEl = contentRoot.querySelector('[data-canvas-styles]') as HTMLStyleElement | null;
    if (!styleEl) return;
    const current = styleEl.textContent || '';
    const selectorEscaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ruleRegex = new RegExp(`${selectorEscaped}\\s*\\{[^}]*\\}\\s*`, 'g');
    styleEl.textContent = current.replace(ruleRegex, '');
}

export function setCanvasTokenVar(name: string, value: string): void {
    if (!contentRoot) return;
    // `--name` lives on the contentRoot element; `var(--name)` resolves to
    // the inline-style value before any rule-based fallback. setProperty is
    // O(1) and triggers a repaint on the next frame for every consumer.
    const propName = name.startsWith('--') ? name : `--${name}`;
    contentRoot.style.setProperty(propName, value);
}

export function loadFontInIframe(fontUrl: string): void {
    // Cross-origin parent (3333) can't reach into iframe (5174) directly,
    // so the parent's `loadGoogleFont` calls this through Comlink. Append
    // a `<link>` to OUR document.head — same effect as the parent
    // injecting one for itself. Idempotent: dedupe by exact href so
    // re-hovering the same font row doesn't spam tags.
    if (document.head.querySelector(`link[href="${fontUrl}"]`)) return;
    const link = document.createElement('link');
    link.href = fontUrl;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
}

export function setCanvasTokensCSS(tokensCSS: string): void {
    if (!contentRoot) return;
    const styleEl = contentRoot.querySelector('[data-canvas-styles]') as HTMLStyleElement | null;
    if (!styleEl) return;
    const current = styleEl.textContent || '';
    const startMarker = '/* canvas-tokens-start */';
    const endMarker = '/* canvas-tokens-end */';
    const startIdx = current.indexOf(startMarker);
    const endIdx = current.indexOf(endMarker);
    if (startIdx >= 0 && endIdx > startIdx) {
      // Replace just the tokens block; everything before / after is page CSS
      // / canvas overrides that we don't want to disturb on a 60fps preset
      // edit.
      styleEl.textContent =
        current.slice(0, startIdx) +
        startMarker + '\n' + tokensCSS + '\n' + endMarker +
        current.slice(endIdx + endMarker.length);
    } else {
      // No markers yet — prepend the block so :root vars resolve before
      // any rules that reference them. Subsequent calls hit the fast
      // marker-replace path above.
      styleEl.textContent =
        startMarker + '\n' + tokensCSS + '\n' + endMarker + '\n' + current;
    }
    // Clear any inline CSS variables set via setCanvasTokenVar (live drag
    // path). The stylesheet now has the authoritative values; inline would
    // override and prevent undo / external token changes from being
    // reflected. Iterating contentRoot.style for `--` properties is O(n)
    // in the number of inline custom props, which is small (just whatever
    // the user dragged this session).
    const toRemove: string[] = [];
    for (let i = 0; i < contentRoot.style.length; i++) {
      const p = contentRoot.style[i];
      if (p && p.startsWith('--')) toRemove.push(p);
    }
    for (const p of toRemove) contentRoot.style.removeProperty(p);
}

export function setInnerHTML(nodeId: string, vpPrefix: string, html: string): void {
    if (!contentRoot) return;
    const el = findElByNodeId(contentRoot, vpPrefix, nodeId);
    if (!el) return;
    clearPatchKeyChain(el);
    el.innerHTML = html;
    // No `rectUpdate` here on purpose — the wrapper's CSS box is
    // unchanged by an inner-HTML swap, and the SVG editor library's
    // `getSvgRect` reads `rectCache` every frame for screen↔user-space
    // conversion. A moving rect during drag makes that math drift,
    // visibly jittering anchors/handles.
    //
    // BUT we DO emit fresh corners for SVG: those drive the host's
    // selection/hover overlays via `cornersCache`, and the painted bbox
    // changes on every reshape. Without this emit the selection box
    // stays anchored to the pre-drag wrapper rect after the user
    // exits — the exact symptom of "selection overlay doesn't refit
    // after multiple reshapes". cornersForElement returns painted
    // bbox corners for SVG, regular rotated corners for everything else.
    if (el.tagName.toLowerCase() === 'svg') {
      emit({ type: 'cornersUpdate', nodeId, vpPrefix, corners: cornersForElement(el), decoupled: cornersAreDecoupled(el) });
      // Refresh synthetic bbox keys so the next normalize-on-exit reads
      // the latest geometry from cache (no async getBBox round-trip).
      if (typeof (el as any).getBBox === 'function') {
        try {
          const b = (el as unknown as SVGSVGElement).getBBox();
          emit({ type: 'computedUpdate', nodeId, vpPrefix, styles: {
            __bboxX: String(b.x), __bboxY: String(b.y),
            __bboxWidth: String(b.width), __bboxHeight: String(b.height),
          } });
        } catch { /* ignore */ }
      }
    }
}

export function setAttribute(nodeId: string, vpPrefix: string, attr: string, value: string | null): void {
    if (!contentRoot) return;
    const el = findElByNodeId(contentRoot, vpPrefix, nodeId);
    if (!el) return;
    clearPatchKeyChain(el);
    if (value === null) el.removeAttribute(attr);
    else el.setAttribute(attr, value);
}

export function setChildShapeAttribute(
    parentNodeId: string,
    vpPrefix: string,
    childIndex: number,
    attr: string,
    value: string | null,
  ): void {
    if (!contentRoot) return;
    const parent = findElByNodeId(contentRoot, vpPrefix, parentNodeId);
    if (!parent) return;
    clearPatchKeyChain(parent);
    // Iterate shape-tag children only — skip <defs>, <style>, <title>,
    // etc. so the index lines up with what the path-editor library
    // sees. The set is the same one the host's `nodeTreeToSvgMarkup` /
    // `serializeShape` recognise.
    const SHAPE_TAGS = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path']);
    let i = 0;
    for (const child of Array.from(parent.children)) {
      if (!SHAPE_TAGS.has(child.tagName.toLowerCase())) continue;
      if (i === childIndex) {
        if (value === null) child.removeAttribute(attr);
        else child.setAttribute(attr, value);
        // Presentation attrs (fill/stroke/stroke-width) are OVERRIDDEN by an
        // inline style on a variant/replica tile — framer-motion applies the
        // variant's value as inline style, so the attribute write above is
        // invisible during a live drag (only the next render, on commit, shows
        // it). Mirror these to the inline style too so live slider / color-drag
        // feedback wins immediately; the next render re-applies the committed
        // variant style with the same value. (`d` has no inline style → it
        // already updates live via the attribute.)
        if (attr === 'fill' || attr === 'stroke' || attr === 'stroke-width') {
          const st = (child as unknown as { style?: CSSStyleDeclaration }).style;
          if (st) {
            if (value === null || value === '') st.removeProperty(attr);
            else st.setProperty(attr, value);
          }
        }
        // Stroke-alignment writes need to invoke applyStrokeAlignment
        // imperatively here because in shape-edit mode SvgShapeTool
        // routes through this bridge call only (no source mutation,
        // no renderer pass). Without re-running the alignment logic,
        // toggling Inside/Outside/Center in the Path tool would
        // change `data-stroke-align` on the DOM but never create/
        // update the `<clipPath>` def or the paint-order CSS rule —
        // user picks a new mode in the dropdown and nothing visibly
        // happens. Reads the freshly-set attribute off the live
        // element so the helper sees the new value.
        if (attr === 'data-stroke-align') {
          const attrs: Record<string, string> = {};
          for (const a of Array.from(child.attributes)) attrs[a.name] = a.value;
          const dataId = child.getAttribute('data-id') || '';
          applyStrokeAlignment(child as Element, child.tagName.toLowerCase(), attrs, dataId);
        }
        // Setting a geometry attribute on the inner shape (`transform` for
        // rotation, `d`/`points` for reshape, etc.) changes the PARENT
        // SVG's painted geometry — so the host's selection / hover overlays,
        // which read the parent's rotated corners from `cornersCache`, must
        // be refreshed. Without this emit the selection box freezes at the
        // pre-edit corners for the WHOLE live interaction (RotateManager's
        // live `transform` writes go through here) and only snaps to the
        // new geometry ~100ms later on the post-mouseup re-render — a
        // visible flash. Mirrors `setInnerHTML`: emit corners + synthetic
        // bbox keys, but NOT `rectUpdate` (the wrapper's CSS box is
        // unchanged; a moving rect jitters the editor library's
        // screen↔user-space math).
        if (parent.tagName.toLowerCase() === 'svg') {
          emit({ type: 'cornersUpdate', nodeId: parentNodeId, vpPrefix, corners: cornersForElement(parent), decoupled: cornersAreDecoupled(parent) });
          if (typeof (parent as unknown as SVGSVGElement).getBBox === 'function') {
            try {
              const b = (parent as unknown as SVGSVGElement).getBBox();
              emit({ type: 'computedUpdate', nodeId: parentNodeId, vpPrefix, styles: {
                __bboxX: String(b.x), __bboxY: String(b.y),
                __bboxWidth: String(b.width), __bboxHeight: String(b.height),
              } });
            } catch { /* ignore */ }
          }
          // Also refresh ANCESTORS. When this <svg> is a group CHILD,
          // rotating/reshaping it changes the GROUP's painted bounding box —
          // and the ParentHighlight (the dashed group outline shown while a
          // child is selected) reads the group's corners from cornersCache.
          // Without this the group outline freezes at the pre-rotate fit and
          // only jumps to the new fit on the post-mouseup re-render. The
          // ancestor walk in `emitSubtreeRefresh` re-emits rect+corners for
          // every `data-node-id` ancestor; its descendant walk is a harmless
          // no-op here (the inner shape carries no `data-id`).
          emitSubtreeRefresh(parent, emit);
        }
        // If shape edit is active on this SVG, the library has its own
        // parsed model that will overwrite our DOM change on the next
        // pointermove (it serializes from `this.doc.shapes`, not live
        // DOM). `syncEditorFromLiveSvg` calls `editor.reload()` which
        // re-parses from the live element so the library's model now
        // matches the panel's edit and preserves it through subsequent
        // drags. No-op when shape edit is inactive.
        syncShapeEditorFromLiveSvg();
        return;
      }
      i++;
    }
}

export function patchAttrsAndStyles(nodeId: string, vpPrefix: string, attrs: Record<string, string>, styles: Record<string, string>, important: boolean): void {
    if (!contentRoot) return;
    const el = findElByNodeId(contentRoot, vpPrefix, nodeId);
    if (!el) return;
    // Apply attributes first, styles second — both within the same
    // synchronous tick so the browser only paints AFTER both have
    // landed. No yield, no intermediate frame.
    for (const [key, value] of Object.entries(attrs)) {
      try {
        if (value === '' || value == null) el.removeAttribute(key);
        else el.setAttribute(key, value);
      } catch { /* skip invalid */ }
    }
    applyTwoPass(el, styles, important);
    // Emit fresh rect + corners so the host caches stay in sync. SVG
    // wrappers get painted-bbox corners (selection / hover overlays
    // snap to the visible shape); rect stays on the wrapper for the
    // editor library's coordinate math (see `cornersForElement`).
    const r = el.getBoundingClientRect();
    emit({ type: 'rectUpdate', nodeId, vpPrefix, rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
    emit({ type: 'cornersUpdate', nodeId, vpPrefix, corners: cornersForElement(el), decoupled: cornersAreDecoupled(el) });
    const cs = getComputedStyle(el);
    const computedUpdates: Record<string, string> = {};
    for (const key of Object.keys(styles)) {
      const kebab = toKebab(key);
      computedUpdates[key] = cs.getPropertyValue(kebab);
    }
    emit({ type: 'computedUpdate', nodeId, vpPrefix, styles: computedUpdates });

    // ANCESTOR refresh for SVG group children. When this <svg> sits inside
    // another <svg> (a vector group), its x/y/width/height attrs ARE the
    // group's bbox — so any drag/resize tick that changes them grows or
    // shrinks the group. ParentHighlight reads the group's screen corners
    // from `cornersCache`; without this walk the dashed group outline
    // stays frozen at the pre-drag fit and only catches up on mouseup.
    // Mirrors the equivalent walk in `setChildShapeAttribute` for shape
    // rotation/reshape.
    if (
      Object.keys(attrs).length > 0
      && el.tagName.toLowerCase() === 'svg'
      && el.parentElement?.tagName.toLowerCase() === 'svg'
    ) {
      emitSubtreeRefresh(el, emit);
    }
}
