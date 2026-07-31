// placeholders.ts — drag-time imperative DOM handlers for the sandbox API:
// layout placeholders, element lift/restore, live reparent and delete.
// Extracted verbatim from bridge-sandbox.ts (Phase 7 split).

import { trace } from '@/shared/debug-trace';
import { reparentChildAtIndex, reprefixDataNodeId } from '@/shared/dom-reparent';
import { findElByNodeId, findAllByNodeId } from '../sandbox-dom-utils';
import { contentRoot, emit } from './sandbox-state';
import { applyTwoPass } from './style-handlers';
import { getTrackedStyleKeys, untrackImperativeStyleKeys } from '@/canvas/Renderer';
import { emitRectAndCornersForElement, scheduleRemeasureAllRects, emitSubtreeRefresh } from './rect-emit';

  // Imperative-first delete — drop every copy of the node (all viewports, matched
  // by data-id) from the iframe DOM right now. The host calls this on the delete
  // keystroke so the node vanishes immediately; the async removeNode code mutation
  // then re-parses + re-renders to make it permanent (the element is already gone,
  // so that pass is a no-op for it). Matches removeNode's data-id selector.
export function removeElement(nodeId: string): void {
    if (!contentRoot) return;
    const els = contentRoot.querySelectorAll(`[data-id="${nodeId}"]`);
    // Capture each copy's enclosing NODE scope BEFORE removal — the siblings
    // REFLOW into the removed node's slot, but the host-side rect/corner
    // caches stay pre-delete, freezing overlays + hit-testing at the old
    // layout until a pan/zoom remeasures ("can't select right after delete",
    // live find 2026-07-21). Re-emit each affected scope after removal —
    // the same machinery layout-affecting style patches use.
    const scopes = new Set<HTMLElement>();
    els.forEach((el) => {
      const scope = (el.parentElement?.closest('[data-node-id]') ?? el.parentElement) as HTMLElement | null;
      if (scope) scopes.add(scope);
      el.remove();
    });
    for (const scope of scopes) {
      if (scope.isConnected) emitSubtreeRefresh(scope, emit);
    }
    // The immediate scope refresh restores selectability instantly, but an
    // ancestor HUG (min-content height, centered justify) can settle a few px
    // AFTER this synchronous pass — schedule the debounced full re-measure so
    // every cache converges to the final layout.
    scheduleRemeasureAllRects();
    trace.action('sandbox:removeElement', { nodeId, removed: els.length, scopesRefreshed: scopes.size });
}

  // Imperative-first reparent on drag-mouseup (see CanvasBridge.reparentLive).
  // Best-effort: any ambiguity → no-op; the `move` code commit corrects it.
export function reparentLive(nodeId: string, vpPrefix: string, newParentId: string | null, index: number, styles: Record<string, string>): void {
    if (!contentRoot) return;
    const replicated: string[] = [];
    const root = contentRoot;
    // The dragged element. If a transient duplicate exists, pick the DEEPEST match
    // (same territory as the patchStyles stale-element guard).
    const matches = findAllByNodeId(root, vpPrefix, nodeId);
    if (matches.length === 0) return;
    const depthOf = (el: HTMLElement): number => {
      let d = 0; let p: HTMLElement | null = el.parentElement;
      while (p && p !== root) { d++; p = p.parentElement; }
      return d;
    };
    const el = matches.reduce((a, b) => (depthOf(b) > depthOf(a) ? b : a), matches[0]);

    if (newParentId) {
      // ── Entry: move INTO a layout parent at `index`, then normalize CSS order to
      //    DOM order so the flex/grid slots it exactly where the line indicator was. ──
      const parent = findElByNodeId(root, vpPrefix, newParentId);
      if (!parent) return; // no target in this viewport → let the commit handle it
      reparentChildAtIndex(parent, el, index); // DOM move into the slot + sequential CSS order
      applyTwoPass(el, styles, false);          // position:relative + clear left/top/right/bottom
      // Replicate into EVERY OTHER viewport's copy of this section so the node shows
      // in tablet/mobile instantly too (not ~0.2s later when the re-render fans it
      // out). Reuse a replica copy if one's already rendered, else clone the primary.
      for (const sec of Array.from(root.querySelectorAll<HTMLElement>(`[data-id="${newParentId}"]`))) {
        const secDni = sec.getAttribute('data-node-id') || '';
        if (!secDni.endsWith(newParentId)) continue;
        const replicaPrefix = secDni.slice(0, secDni.length - newParentId.length);
        if (replicaPrefix === vpPrefix) continue; // primary handled above
        let replicaEl = findElByNodeId(root, replicaPrefix, nodeId);
        if (!replicaEl) {
          replicaEl = el.cloneNode(true) as HTMLElement;
          reprefixDataNodeId(replicaEl, vpPrefix, replicaPrefix);
        }
        reparentChildAtIndex(sec, replicaEl, index);
        applyTwoPass(replicaEl, styles, false);
        // PUBLISH the replica's geometry to the HOST under its OWN
        // `${replicaPrefix}:${nodeId}` rect-cache key — the clone exists in the
        // iframe now, but the host has never heard of it.
        //
        // Why it matters: `updateNodeStyles`' page-primary fan-out (node-ops)
        // only pushes a per-frame drag patch to a viewport when
        // `rectCache.has(`${prefix}:${id}`)` — the cache IS its list of "which
        // viewports actually render this node". Mid-drag the mutation queue is
        // held (processQueue's element-drag gate), so NO render runs and the
        // only other cache seed — the post-render `allRects` — never arrives
        // until mouseup. Result: a node dragged from the canvas into a frame
        // APPEARED in tablet/mobile instantly (the clone above) but then FROZE
        // there for the rest of the gesture while the primary kept following
        // the cursor; it only tracked live on a SECOND drag, once the post-drop
        // render had finally seeded the cache. Live find 2026-07-24.
        emitRectAndCornersForElement(replicaEl);
        replicated.push(replicaPrefix);
      }
    } else {
      // ── Exit: the node collapses to a single canvas node — drop the replica
      //    copies so THEIR siblings re-flow now, then lift the primary to the content
      //    root (the commit re-homes it to the exact canvas spot). ──
      for (const copy of Array.from(root.querySelectorAll<HTMLElement>(`[data-id="${nodeId}"]`))) {
        if (copy !== el) copy.remove();
      }
      if (el.parentElement !== root) root.appendChild(el);
      // Canvas-root elements carry the CANONICAL (unprefixed) data-node-id.
      // A replica-frame exit lifts a `tablet-…` element — normalize the whole
      // subtree so per-frame `patchStyles('', id)` lookups and the Renderer's
      // patchCanvasNodes reconciliation find THIS element instead of building
      // a drag-locked duplicate at the root mid-drag.
      if (vpPrefix) reprefixDataNodeId(el, vpPrefix, '');
      applyTwoPass(el, styles, false);
    }

    trace.action('sandbox:reparentLive', {
      nodeId, vpPrefix, newParentId, index, styleKeys: Object.keys(styles),
      replicaPrefixes: replicated, replicaCount: replicated.length,
    });
    emitRectAndCornersForElement(el);
}

export function createPlaceholder(
    placeholderId: string,
    parentNodeId: string,
    vpPrefix: string,
    beforeNodeId: string | null,
    styles: Record<string, string>,
  ): void {
    if (!contentRoot) return;
    const parent = findElByNodeId(contentRoot, vpPrefix, parentNodeId) as HTMLElement;
    if (!parent) return;
    const ph = document.createElement('div');
    ph.setAttribute('data-layout-placeholder', 'true');
    ph.setAttribute('data-placeholder-id', placeholderId);
    for (const [key, value] of Object.entries(styles)) {
      try { (ph.style as any)[key] = value; } catch { /* skip */ }
    }
    if (beforeNodeId) {
      const before = parent.querySelector(`[data-id="${beforeNodeId}"]`) as HTMLElement;
      parent.insertBefore(ph, before);
    } else {
      parent.appendChild(ph);
    }
}

export function movePlaceholder(
    placeholderId: string,
    parentNodeId: string,
    vpPrefix: string,
    beforeNodeId: string | null,
  ): void {
    if (!contentRoot) return;
    const parent = findElByNodeId(contentRoot, vpPrefix, parentNodeId) as HTMLElement;
    if (!parent) return;
    const ph = parent.querySelector(`[data-placeholder-id="${placeholderId}"]`) as HTMLElement;
    if (!ph) return;
    if (beforeNodeId) {
      const before = parent.querySelector(`[data-id="${beforeNodeId}"]`) as HTMLElement;
      parent.insertBefore(ph, before);
    } else {
      parent.appendChild(ph);
    }
    // The move reflows every sibling — re-emit the parent scope NOW so the
    // host rect caches track the live layout mid-drag (the old canvas-dnd
    // library read live rects each frame; frozen caches were the root of
    // every reorder hit-test asymmetry, 2026-07-23).
    if (parent.isConnected) emitSubtreeRefresh(parent, emit);
}

export function patchPlaceholderStyles(placeholderId: string, _vpPrefix: string, styles: Record<string, string>): void {
    if (!contentRoot) return;
    const ph = contentRoot.querySelector(`[data-placeholder-id="${placeholderId}"]`) as HTMLElement | null;
    if (!ph) return;
    applyTwoPass(ph, styles, false);
    // Order/size patches reflow the siblings (order-based placeholder moves
    // route through here) — keep the host rect caches live, same as
    // movePlaceholder above.
    const phParent = ph.parentElement as HTMLElement | null;
    if (phParent?.isConnected) emitSubtreeRefresh(phParent, emit);
}

  /** Swap two siblings' DOM positions inside a shared parent. Used by
   *  GridDragStrategy for auto-flow grids where DOM order drives visual
   *  cell placement — swapping placeholder and target in DOM causes the
   *  browser's grid auto-flow to repaint them in each other's cells.
   *
   *  Accepts a node id (data-id) OR a placeholder id (data-placeholder-id)
   *  for either argument so the strategy can pass `phId` + `nodeId` in
   *  either order. */
export function swapTwoElements(
    idA: string,
    idB: string,
    parentNodeId: string,
    vpPrefix: string,
  ): void {
    if (!contentRoot || idA === idB) return;
    const parent = findElByNodeId(contentRoot, vpPrefix, parentNodeId);
    if (!parent) return;
    const findChild = (id: string): HTMLElement | null =>
      parent.querySelector(`:scope > [data-id="${id}"]`)
      ?? parent.querySelector(`:scope > [data-placeholder-id="${id}"]`);
    const a = findChild(idA);
    const b = findChild(idB);
    if (!a || !b || a === b) return;

    // Adjacent: a single insertBefore is enough. `insertBefore(node, ref)`
    // detaches `node` and re-inserts it before `ref`, so moving the later
    // sibling before the earlier one swaps them in one op.
    if (a.nextSibling === b) { parent.insertBefore(b, a); return; }
    if (b.nextSibling === a) { parent.insertBefore(a, b); return; }

    // Non-adjacent: capture each one's RIGHT-NEIGHBOR before any move
    // (insertBefore mutates sibling order, so reading nextSibling after
    // the first move would be stale). Then put each element at the
    // other's old position.
    const aNext = a.nextSibling;
    const bNext = b.nextSibling;
    if (aNext) parent.insertBefore(b, aNext); else parent.appendChild(b);
    if (bNext) parent.insertBefore(a, bNext); else parent.appendChild(a);
}

export function removePlaceholders(placeholderIds: string[]): void {
    if (!contentRoot) return;
    for (const id of placeholderIds) {
      const ph = contentRoot.querySelector(`[data-placeholder-id="${id}"]`);
      ph?.remove();
    }
}

  /** Read a placeholder's bounding rect. Returns iframe-local; the host
   *  wraps with `toParentSpace` to add the iframe offset. */
export function getPlaceholderRect(
    placeholderId: string,
  ): { left: number; top: number; width: number; height: number } | null {
    if (!contentRoot) return null;
    const ph = contentRoot.querySelector(`[data-placeholder-id="${placeholderId}"]`) as HTMLElement | null;
    if (!ph) return null;
    const r = ph.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** ATOMIC drop-endgame for a merged templated root — everything in ONE sandbox
 *  task so the browser can never paint an intermediate state:
 *    1. remove the drag placeholders,
 *    2. restore the dragged element(s) back into flow,
 *    3. physically arrange the parent's children to `orderedIds` (DOM order
 *       becomes the desired order — matching the JSX-reorder the page commit
 *       writes asynchronously),
 *    4. clear every child's inline CSS `order` (incl. the drag's !important
 *       rank stamps) so nothing fights the new DOM order.
 *  The old flow did these as SEPARATE postMessages (restore, then one patch
 *  per child) — each message is its own macrotask, the sandbox painted between
 *  them, and for a frame the restored section (order '') sorted above its
 *  still-×10-stamped siblings: the "jumps above for 0.2s then repositions"
 *  glitch on every templated-root drop (trace 2026-07-28).
 *
 *  Children whose element is NOT currently parented under `parentNodeId`
 *  (a portaled overlay) keep their position — never yanked back. */
export function commitMergedOrder(
    parentNodeId: string,
    vpPrefix: string,
    participantIds: string[],
    restores: Array<{ nodeId: string; styles: Record<string, string> }>,
    placeholderIds: string[],
    chromeOrderRestores: Array<{ nodeId: string; order: string }> = [],
  ): void {
    if (!contentRoot) return;
    const parent = findElByNodeId(contentRoot, vpPrefix, parentNodeId);
    if (!parent) return;
    // SNAPSHOT the child list FIRST: the drag PLACEHOLDER marks the dragged
    // section's slot, and the lifted section is still out of the parent — so
    // the participant SLOTS are exactly [in-DOM participants + placeholders],
    // in DOM order. (Restoring first inserted the dragged el at index 0,
    // which minted a bogus participant slot BEFORE the header.)
    const before = Array.from(parent.children);
    for (const r of restores) {
      restoreNode(r.nodeId, parentNodeId, vpPrefix, 0, r.styles); // styles; position fixed below
    }
    // Arrange ONLY the reorder PARTICIPANTS (the page sections), in their new
    // sequence, using the participant/placeholder SLOTS — every other child
    // (template chrome, a fixed-video OVERLAY, absolutes) keeps its exact DOM
    // position. The first version appended EVERY child to a cache-derived
    // sequence, which physically moved the overlay (violating its
    // root's-last-child invariant + paint order) and re-slotted chrome from a
    // list that need not match the live DOM (user report 2026-07-28: "the
    // overlay must be completely ignored in all drag calculations").
    const participantSet = new Set(participantIds);
    const fullSeq: Element[] = [];
    let pi = 0;
    for (const child of before) {
      const rawId = (child.getAttribute('data-node-id') || '').slice(vpPrefix.length);
      const isSlot = participantSet.has(rawId) || (child as HTMLElement).hasAttribute?.('data-layout-placeholder');
      if (isSlot) {
        const nextId = participantIds[pi++];
        const el = nextId ? findElByNodeId(contentRoot, vpPrefix, nextId) : null;
        fullSeq.push(el && el.parentElement === parent ? el : child);
      } else {
        fullSeq.push(child);
      }
    }
    for (const el of fullSeq) parent.appendChild(el);
    // Placeholders die AFTER the arrangement (they served as slot markers) —
    // same task, so the column never paints the closed gap.
    if (placeholderIds.length > 0) removePlaceholders(placeholderIds);
    // Clear the drag's rank stamps on the participants only (their committed
    // source carries no inline order — JSX order governs)…
    for (const id of participantIds) {
      const el = findElByNodeId(contentRoot, vpPrefix, id);
      if (el && el.parentElement === parent && el.style.order !== '') {
        applyTwoPass(el, { order: '' }, false);
      }
    }
    // …and RESTORE (not clear) the bracketed template chrome's pre-drag order
    // in the same task. Clearing it left the footer at order 0 for the window
    // until the next render re-applied the merge bracket — on a replica whose
    // sections still carried source orders, the footer sorted up right under
    // the hero (the mobile footer-under-hero report, 2026-07-28).
    for (const { nodeId, order } of chromeOrderRestores) {
      const el = findElByNodeId(contentRoot, vpPrefix, nodeId);
      if (el && el.parentElement === parent) {
        applyTwoPass(el, { order }, false);
      }
    }
    trace.action('sandbox:commitMergedOrder', {
      parentNodeId, vpPrefix, participants: participantIds.length,
      restores: restores.map((r) => r.nodeId), placeholders: placeholderIds.length,
      chromeRestores: chromeOrderRestores,
    });
    scheduleRemeasureAllRects();
}

export function liftNode(nodeId: string, vpPrefix: string, styles: Record<string, string>): void {
    if (!contentRoot) return;
    const el = findElByNodeId(contentRoot, vpPrefix, nodeId) as HTMLElement;
    if (!el) return;

    // Capture inherited text properties BEFORE reparenting. Lifting moves the
    // element to contentRoot (so it can drag freely across viewport boundaries
    // / out of overflow:hidden ancestors), but that severs CSS inheritance
    // from the layout body — without preserving these, an element using the
    // page's default font visibly switches to Times-serif during drag.
    // Skip props the element already overrides inline so we don't blow away
    // the user's own values.
    const cs = getComputedStyle(el);
    const INHERITED_PROPS = [
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
      'lineHeight', 'letterSpacing', 'wordSpacing', 'textAlign',
      'textTransform', 'textIndent', 'whiteSpace', 'wordBreak',
      'overflowWrap', 'color',
    ] as const;
    const preserved: Record<string, string> = {};
    for (const prop of INHERITED_PROPS) {
      if (el.style[prop as any]) continue; // already explicit, leave alone
      const v = cs[prop as any];
      if (v) preserved[prop] = v as string;
    }

    // SNAPSHOT the element's PRE-LIFT inline value for every prop the lift
    // is about to touch — this is the DOM TRUTH the restore must return to.
    // The strategies' restore styles come from the parsed node MODEL, and a
    // prop resolved from CONDITIONAL/variant styles (e.g. a component root's
    // `height: variant === 'x' ? 'min-content' : '418px'`, applied inline by
    // the renderer) has NO entry in `styles` — the model-based restore wrote
    // `height: ''`, the element fell to content-auto, and the patch pass
    // never re-applied it (the imperative write is tracked): a component
    // instance stayed visibly collapsed after every layout drag until a page
    // switch rebuilt it (user report 2026-07-27). Stored as an attribute so
    // it survives anything short of element removal.
    const preLift: Record<string, string> = {};
    for (const k of Object.keys(styles)) {
      preLift[k] = ((el.style as unknown as Record<string, string>)[k] ?? '');
    }
    el.setAttribute('data-lift-inline-snapshot', JSON.stringify(preLift));
    // …and snapshot the TRACKING state of those props (captured BEFORE the
    // applyTwoPass below adds every lift key to the tracked set). Tracked
    // keys are handed to the next render's stale-clear, which reconciles
    // them against the node's resolved styles — so a lift-touched key that
    // was NOT tracked pre-lift (an instance wrapper's build-only inline
    // width/height has no model entry) must be UNTRACKED again on restore,
    // or the next render — triggered by ANYTHING, e.g. an unrelated grid
    // drag's commit — stale-clears it and the instance collapses
    // (2026-07-27, second layer of the lesson-42 bug).
    const trackedNow = getTrackedStyleKeys(el);
    const preTracked = Object.keys(styles).filter((k) => trackedNow?.has(k) ?? false);
    el.setAttribute('data-lift-tracked-keys', preTracked.join(','));

    // TWO-PASS (clear empties, then set) via the shared canonical — a
    // single object-order pass lets an empty longhand applied after a
    // shorthand wipe the shorthand's expansion (same bug class restoreNode
    // already guarded against).
    applyTwoPass(el, styles, false);
    // Apply preserved inheritance AFTER caller styles so caller can still
    // override (caller styles are always explicit drag-related: position,
    // left, top, etc.; they don't touch text properties).
    const preservedKeys: string[] = [];
    for (const [k, v] of Object.entries(preserved)) {
      try {
        (el.style as any)[k] = v;
        preservedKeys.push(k);
      } catch { /* skip */ }
    }
    // Mark which props we forced inline so restoreNode (or a later patch
    // pass) knows to clear them — without this they'd outlive the drag and
    // leak the lifted-time computed values into committed code.
    if (preservedKeys.length > 0) {
      el.setAttribute('data-lift-preserved-props', preservedKeys.join(','));
    }
    contentRoot.appendChild(el);
}

export function restoreNode(
    nodeId: string,
    parentNodeId: string,
    vpPrefix: string,
    index: number,
    styles: Record<string, string>,
  ): void {
    if (!contentRoot) return;
    const el = findElByNodeId(contentRoot, vpPrefix, nodeId);
    const parent = findElByNodeId(contentRoot, vpPrefix, parentNodeId);
    if (!el || !parent) return;
    // Clear the inheritance-preservation styles applied during liftNode.
    // Now that the element is going back into a real DOM parent it inherits
    // fonts / colors naturally; leaving the inline copies behind would bake
    // computed values into the next commit and override responsive rules.
    const preservedAttr = el.getAttribute('data-lift-preserved-props');
    if (preservedAttr) {
      for (const k of preservedAttr.split(',')) {
        if (k) try { (el.style as any)[k.trim()] = ''; } catch { /* skip */ }
      }
      el.removeAttribute('data-lift-preserved-props');
    }
    // Apply restore styles FIRST (clears absolute lift styles) so the element
    // re-flows into the parent's flex/grid layout the moment we move it.
    // TWO-PASS via the shared canonical — a single object-order pass lets an
    // empty longhand (flexShrink/flexGrow/flexBasis: '') applied AFTER the
    // `flex` shorthand wipe the shorthand's expansion → the restored
    // flex-fill child collapses (the "doubles/shrinks then re-expands on
    // mouseup" bug) until the next source re-render.
    //
    // PRE-LIFT INLINE SNAPSHOT WINS for every prop the lift touched (see
    // liftNode): the passed `styles` come from the parsed MODEL, which knows
    // nothing about conditional/variant-resolved inline values the renderer
    // applied — the DOM's own pre-lift value is the truth for those. Keys the
    // snapshot doesn't hold (order, pointerEvents, …) keep the caller's
    // intent (e.g. the commit re-stamps clean orders).
    let merged = styles;
    let snap: Record<string, string> | null = null;
    const snapAttr = el.getAttribute('data-lift-inline-snapshot');
    if (snapAttr) {
      try {
        snap = JSON.parse(snapAttr) as Record<string, string>;
        merged = { ...styles, ...snap };
      } catch { /* corrupt snapshot — fall back to the model styles */ }
      el.removeAttribute('data-lift-inline-snapshot');
    }
    applyTwoPass(el, merged, false);
    // Return the TRACKING state to pre-lift truth. applyTwoPass just tracked
    // every restored key — but tracking hands a key to the next render's
    // stale-clear, which reconciles it against the node's resolved styles.
    // A lift-touched key that was NOT tracked pre-lift (an instance wrapper's
    // build-only inline width/height has no model entry) would get CLEARED by
    // whatever render comes next — the "instance collapses when a LATER,
    // unrelated drag commits" bug (2026-07-27). Caller-only keys the lift
    // never touched (order, pointerEvents re-stamps) stay tracked: those ARE
    // model-bound commit intent.
    const trackedAttr = el.getAttribute('data-lift-tracked-keys');
    if (snap) {
      const preTracked = new Set((trackedAttr ?? '').split(',').filter(Boolean));
      const untrack = Object.keys(snap).filter((k) => !preTracked.has(k));
      if (untrack.length > 0) {
        untrackImperativeStyleKeys(el, untrack);
        trace.action('sandbox:restoreNode-untrack', { nodeId, vpPrefix, keys: untrack, keptTracked: Array.from(preTracked) });
      }
    }
    if (trackedAttr !== null) el.removeAttribute('data-lift-tracked-keys');
    // Insert at target index among children that have data-id and aren't placeholders.
    const siblings = Array.from(parent.children).filter(
      (c) => c.hasAttribute('data-id') && c !== el && !(c as HTMLElement).hasAttribute('data-layout-placeholder'),
    );
    if (index >= siblings.length) parent.appendChild(el);
    else parent.insertBefore(el, siblings[index]);
    // DIAGNOSTIC: capture the post-restore live widths so a transient size jump
    // (e.g. a flex-fill child briefly 2× because a lingering placeholder still
    // holds a flex slot, or orders aren't committed yet) is visible in the
    // trace. Logs the restored element + every parent child (id, width, flex,
    // order) right after the DOM move.
    try {
      const phCount = Array.from(parent.children).filter(
        (c) => (c as HTMLElement).hasAttribute('data-layout-placeholder'),
      ).length;
      const kids = Array.from(parent.children).map((c) => {
        const k = c as HTMLElement;
        return {
          id: k.getAttribute('data-node-id') || (k.hasAttribute('data-layout-placeholder') ? 'PLACEHOLDER' : `<${k.tagName.toLowerCase()}>`),
          w: Math.round(k.getBoundingClientRect().width),
          flex: k.style.flex || '', order: k.style.order || '', width: k.style.width || '',
        };
      });
      trace.action('sandbox:restoreNode-widths', {
        nodeId, index, parentW: Math.round(parent.getBoundingClientRect().width),
        elW: Math.round(el.getBoundingClientRect().width), placeholderCount: phCount, kids,
      });
    } catch { /* trace best-effort */ }
    // The DOM move shifts the restored node AND every following sibling — their
    // cached rects are now stale, so the selection/hover overlay would sit at
    // the OLD position until the async source re-render re-emits allRects
    // (~0.5s on a big page). Re-emit every node's rect now (rAF-debounced, so
    // the primary + replica restoreNode calls coalesce into one cheap measure)
    // → overlays snap to the new position instantly. Positional-only: no DOM
    // rebuild, no computed recompute, no React/Code component teardown.
    scheduleRemeasureAllRects();
}
