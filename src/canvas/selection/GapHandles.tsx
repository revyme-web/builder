// GapHandles.tsx — Pink handles between flex/grid children for adjusting gap.
// Ported from old builder: scale-aware sizing, hover overlays, clamping,
// rotation check, flex-wrap check, absolute child filtering.

import React, { useState, useCallback, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { getNodeFromCache } from '@/code/stores/store';
import { useNode } from '@/code/stores/node-family';
import { containerOverridesAtom, getOverridesAtWidth } from '@/code/stores/container-query-store';
import { viewportWidthsAtom } from '@/code/stores/viewport-store';
import { isPrimaryViewport } from '@/shared/constants';
import { wrapHidesGapHandles } from '@/shared/flex-helpers';
import { findNodeRect, findNodeComputedStyles, findVisibleChildRects, updateNodeStyles, getContentRoot, getViewportPrefix } from '@/canvas/node-ops';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { transformManager } from '@/canvas/transform';
import { nodeOrAncestorHasRotationOrSkewById } from '@/canvas/resize/geometry-utils';
import { styleHelperOps } from './style-helper-store';
import { useRafForceRenderTick } from '@/canvas/hooks/useRafForceRenderTick';
import { withLiveRects, liveChildRectsSupported } from './live-child-rects';
import { trace } from '@/shared/debug-trace';

interface Props {
  nodeId: string;
  vpId: string;
  onInteracting: (v: boolean) => void;
}

export default function GapHandles({ nodeId, vpId, onInteracting }: Props) {
  // Per-node subscription — this overlay only cares about the selected
  // container; an unrelated commit no longer re-renders it. The child
  // position fallback below reads the imperative cache (same data, no
  // subscription needed — the child list itself comes from live rect polls).
  const node = useNode(nodeId);
  // Per-viewport @media/@container overrides — a REPLICA's wrap/direction can
  // live ONLY here (e.g. `flex-wrap: wrap !important` on the tablet tile), so
  // the wrap gate below must consult this map, not just base/computed styles.
  const containerOverrides = useAtomValue(containerOverridesAtom);
  const vpWidths = useAtomValue(viewportWidthsAtom);
  const [hoveredGapIndex, setHoveredGapIndex] = useState<number | null>(null);
  // Bumped on every pointermove during gap drag to force a re-render
  // so the handles re-read fresh `findVisibleChildRects` from the bridge
  // rectCache. Without this, `domOnly: true` patches update the cache
  // but no React render fires until mouseup's full commit — handles
  // visually stayed at the pre-drag position the entire drag, then
  // jumped on mouseup. RAF polling while dragging keeps them tracking
  // the children continuously, same approach `InteractionOutline`
  // uses for the outline. (Shared pump: useRafForceRenderTick.)
  const { tick: rafTick, start: startRafTick, stop: stopRafTick } = useRafForceRenderTick();

  const isCollectionList = !!node?.collectionList;

  // ─── Child geometry: LIVE read, never the sync cache ───────────────────────
  //
  // These handles reappeared at their pre-drag position after a padding (or gap)
  // drag and corrected ~0.3s later — the visible jump (user report 2026-07-26).
  //
  // Two facts make the sync cache unusable at that moment:
  //   1. `SelectionOverlay` UNMOUNTS every handle for the duration of an
  //      interaction (its `if (isInteracting)` early return; the gesture itself
  //      survives on window listeners). So this component doesn't render during
  //      the drag at all — it MOUNTS FRESH on pointer-up, with no state to carry
  //      a tracked position forward.
  //   2. Throughout that gesture the sandbox downgraded each patch's subtree
  //      refresh to the patched ELEMENT only (`setDndInteracting`, a deliberate
  //      perf call — `sandbox:subtree-refresh` fired ZERO times across the
  //      reported drag). So at mount every CHILD rect in the cache is pre-drag,
  //      and stays that way until the gesture-end `forceRemeasureAllRects`
  //      sweep lands — the ~0.3s.
  //
  // PaddingHandles survives the same remount unscathed because it reads only the
  // container's OWN rect + computed padding, both of which the per-patch emit
  // keeps fresh. Same principle applied here: paint from a LIVE read of the
  // children, and suppress the paint until it resolves (one bridge round-trip)
  // rather than showing a stale frame.
  const [liveRects, setLiveRects] = useState<Map<string, DOMRect> | null>(null);
  // `null` until the first read resolves, then never null again — so we can tell
  // "no data yet" (suppress the paint) from "read returned nothing".
  const awaitingFirstRead = liveRects === null && liveChildRectsSupported(getCanvasBridge());

  useEffect(() => {
    if (isCollectionList) return;   // collection lists read their own rows below
    const bridge = getCanvasBridge();
    if (typeof bridge.getChildRectsAsync !== 'function') return;
    let cancelled = false;
    void bridge.getChildRectsAsync(nodeId, getViewportPrefix(vpId)).then(rects => {
      if (cancelled) return;
      trace.action('gap-handles:live-rects', { nodeId, vpId, children: rects.length });
      setLiveRects(new Map(rects.map(r => [r.id, r.rect] as const)));
    });
    return () => { cancelled = true; };
    // `node` identity: re-read after each commit lands, so the handles follow a
    // layout change that arrives without a remount.
  }, [isCollectionList, nodeId, vpId, node, rafTick]);

  // CMS collection lists render GHOST rows (DOM-only clones of the .map()
  // template) that share the template's data-id, so the host's data-id-keyed
  // rectCache can't hold them and `findVisibleChildRects` (model children only)
  // never sees them — only template + LoadMore, yielding a single mis-placed
  // gap handle. Pull the LIVE DOM children (ghosts included, in DOM order) via
  // the async bridge read instead. Refreshes on the RAF tick so handles still
  // track while a gap drag grows the rows apart.
  const [domChildRects, setDomChildRects] = useState<Array<{ id: string; rect: DOMRect }>>([]);
  useEffect(() => {
    if (!isCollectionList) { setDomChildRects([]); return; }
    const bridge = getCanvasBridge();
    if (typeof bridge.getChildRectsAsync !== 'function') return;
    let cancelled = false;
    bridge.getChildRectsAsync(nodeId, getViewportPrefix(vpId)).then(rects => {
      if (!cancelled) setDomChildRects(rects);
    });
    return () => { cancelled = true; };
  }, [isCollectionList, nodeId, vpId, rafTick]);

  const startAdjustingGap = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const contentEl = getContentRoot();
    if (!contentEl) return;

    const scale = transformManager.getTransform().scale;
    // Read flex direction and gap via bridge
    const cs = findNodeComputedStyles(nodeId, vpId, ['flexDirection', 'flex-direction', 'gap']);
    const flexDir = cs['flexDirection'] || cs['flex-direction'] || '';
    const isHorizontal = flexDir === 'row' || flexDir === 'row-reverse';
    const startX = e.clientX;
    const startY = e.clientY;

    // Parse computed gap (handles "10px 10px" or "10px" formats)
    const computedGap = cs['gap'] || '';
    let currentGap = 0;
    if (computedGap) {
      currentGap = parseInt(computedGap.includes(' ') ? computedGap.split(' ')[0] : computedGap) || 0;
    }

    trace.action('gap-handle:start', { nodeId, currentGap, isHorizontal });
    onInteracting(true);

    // Spin up a RAF loop that re-reads child rects from the bridge
    // rectCache every frame so the handle DOM positions track the
    // children as the gap grows. We bump a tick state to trigger the
    // re-render — cheap because GapHandles' render is small (loops
    // children once and emits a few <div>s).
    startRafTick();

    // Track last gap value for commit on mouseUp
    let lastGap = currentGap;

    styleHelperOps.show({
      type: 'gap',
      position: { x: e.clientX, y: e.clientY },
      value: currentGap,
      unit: 'px',
    });

    const onMove = (me: PointerEvent) => {
      me.preventDefault();
      const delta = isHorizontal
        ? (me.clientX - startX) / scale
        : (me.clientY - startY) / scale;
      const newGap = Math.max(0, Math.round(currentGap + delta));
      lastGap = newGap;

      // Imperative DOM update via bridge — sync to all variant copies
      updateNodeStyles({ id: nodeId, styles: { gap: `${newGap}px` }, contentEl, domOnly: true });

      styleHelperOps.show({
        type: 'gap',
        position: { x: me.clientX, y: me.clientY },
        value: newGap,
        unit: 'px',
      });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);

      // Stop the RAF poll. The final re-render below from the commit
      // path uses the now-stable rectCache, so handles land cleanly
      // on the new gap position with no visible "jump" on release.
      stopRafTick();

      // Commit to code
      updateNodeStyles({ id: nodeId, styles: { gap: `${lastGap}px` }, contentEl });
      styleHelperOps.hide();
      onInteracting(false);
      trace.action('gap-handle:end', { nodeId, gap: `${lastGap}px` });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [nodeId, vpId, onInteracting, startRafTick, stopRafTick]);

  // ─── Early returns (ported from old builder) ─────────────────────────────

  const scale = transformManager.getTransform().scale;
  const frameRect = findNodeRect(nodeId, vpId);
  if (!frameRect || !node || scale < 0.2) return null;

  // Hide gap handles when the frame or any ancestor has rotation/skew —
  // the handles are screen-aligned (`position:fixed` in screen space) and
  // would land off the visible gap once the parent's transform tilts the
  // children away from the AABB axes the handle math assumes.
  if (nodeOrAncestorHasRotationOrSkewById(nodeId, vpId)) return null;

  // Only frames (divs with children)
  if (node.children.length === 0) return null;

  const computed = findNodeComputedStyles(nodeId, vpId, ['display', 'flexWrap', 'flex-wrap', 'flexDirection', 'flex-direction']);

  // Flex only — grid is intentionally excluded. The single-axis handle
  // model (one strip per "gap" between adjacent children) assumes a
  // 1D layout. CSS Grid has TWO independent gap axes (`row-gap` and
  // `column-gap`) AND grid items aren't necessarily packed adjacent —
  // they can span cells, skip cells, place by name. Painting flex-style
  // handles on a grid drops false positives between non-adjacent cells
  // (visible in the user's screenshot: pink bars between cards that
  // aren't actually sharing a gap row). Grid gap edits go through the
  // inspector's Gap field instead.
  const display = computed['display'] || '';
  if (!display.includes('flex') || display.includes('grid')) return null;

  // No flex-wrap: wrap/wrap-reverse — once children wrap onto multiple lines the
  // single-axis "gap between adjacent children" model is ambiguous (the handles
  // would point at cross-line neighbours), so hide them entirely. On a REPLICA
  // the wrap can live ONLY in the viewport's @media override (base says nothing,
  // and the computed cache doesn't reliably carry flexWrap for replica keys) —
  // resolve the override map for THIS viewport's width FIRST; an explicit
  // override back to 'nowrap' re-shows the handles even when the base wraps.
  // Then the SOURCE style (`node.styles`, updated synchronously when the user
  // toggles Wrap — the computed read can lag after a toggle), then computed
  // (covers wrap from a code-component stylesheet).
  const replicaOverrides = !isPrimaryViewport(vpId) && vpWidths[vpId]
    ? getOverridesAtWidth(containerOverrides, nodeId, vpWidths[vpId])
    : null;
  if (wrapHidesGapHandles(replicaOverrides, node.styles, computed)) {
    trace.action('gap-handles:hidden-by-wrap', {
      nodeId, vpId, fromReplicaOverride: !!(replicaOverrides?.get('flexWrap') || replicaOverrides?.get('flex-wrap')),
    });
    return null;
  }

  const flexDir = replicaOverrides?.get('flexDirection') || replicaOverrides?.get('flex-direction')
    || computed['flexDirection'] || computed['flex-direction'] || '';
  const isColumn = flexDir === 'column' || flexDir === 'column-reverse';

  // Get VISIBLE child rects via bridge — filters out children that
  // are `display:none` for this vpId (variant-only / @media-only) AND
  // children with 0×0 rects. A hidden sibling has a phantom rect at
  // its inline `left`/`top` from the layout engine, which would drop
  // a handle "between" two visible children that look adjacent on
  // screen but aren't adjacent in `node.children` order. Same filter
  // `calculateLayoutInsertIndexById` and `DropLineIndicator` use, so
  // the handle slots line up with the visible gap users see.
  // Collection lists: use the LIVE DOM children (ghosts included). They're all
  // in-flow flex rows, so the only filter needed is dropping 0×0 (not-yet-laid-
  // out) rects. Use the array INDEX in keys since ghosts share the template's
  // data-id (non-unique). Falls back to the sync model path until the first
  // async fetch resolves.
  const unsortedElsBase = (isCollectionList && domChildRects.length >= 2)
    ? domChildRects
        .filter(c => c.rect.width !== 0 || c.rect.height !== 0)
        .map((c, i) => ({ id: `${c.id}__row${i}`, rect: c.rect }))
    : findVisibleChildRects(nodeId, vpId)
        .filter(c => new Set(node.children).has(c.id))
        // Out-of-flow children (`position: absolute` / `fixed`) don't
        // participate in the flex/grid gap — they're positioned independently
        // of their siblings, so a "gap handle" paired with one would sit on
        // empty space (or land on top of an unrelated in-flow child). The gap
        // is only meaningful between IN-FLOW (relative/static) children.
        // Computed style is the source of truth for what's rendered; the
        // inline-style fallback covers children whose `position` isn't in the
        // bridge's prefetched computed cache.
        .filter(c => {
          const pos = findNodeComputedStyles(c.id, vpId, ['position']).position
            || getNodeFromCache(c.id)?.styles?.position
            || '';
          return pos !== 'absolute' && pos !== 'fixed';
        })
        .map(c => ({ id: c.id, rect: c.rect }));
  const unsortedEls = withLiveRects(unsortedElsBase, isCollectionList ? null : liveRects);

  // Suppress the paint until the live read lands (one bridge round-trip). At
  // mount-after-a-gesture the cached child rects are pre-drag, so painting now
  // is exactly the reported jump; the alternative is one frame of no handles.
  // Collection lists have their own live read (`domChildRects`) and gate on it
  // by falling back to the model path, so they don't wait here.
  if (awaitingFirstRead && !isCollectionList) {
    trace.action('gap-handles:awaiting-live-rects', { nodeId, vpId });
    return null;
  }

  if (unsortedEls.length < 2) return null;

  // Sort by visual position so the loop below pairs visually-adjacent
  // siblings, not JSX-adjacent ones. CSS `order` (written by reorder
  // operations) rearranges children visually without changing
  // node.children order — without this sort the gap math computes
  // r1.bottom → r2.top spanning a non-adjacent sibling, landing the
  // handle on top of an unrelated child instead of in the gap.
  const childEls = isColumn
    ? [...unsortedEls].sort((a, b) => a.rect.top - b.rect.top)
    : [...unsortedEls].sort((a, b) => a.rect.left - b.rect.left);

  // ─── Fixed screen-space sizing, clamped to container ──────────────────

  let handleW = 28; // fixed screen pixels (matches old builder visual)
  const handleH = 4;
  if (isColumn) {
    if (handleW > frameRect.width * 0.8) handleW = frameRect.width * 0.8;
  } else {
    if (handleW > frameRect.height * 0.8) handleW = frameRect.height * 0.8;
  }
  if (handleW < 4 || handleH < 4) return null;

  // ─── Build gap elements ─────────────────────────────────────────────────

  const gapElements: React.ReactNode[] = [];

  for (let i = 0; i < childEls.length - 1; i++) {
    const r1 = childEls[i].rect;
    const r2 = childEls[i + 1].rect;

    if (isColumn) {
      const gapTop = r1.bottom;
      const gapBottom = r2.top;
      const gapH = gapBottom - gapTop;
      // Render the HANDLE even when gapH is 0 (children touch with no
      // gap). Grabbing it and dragging is the affordance for "add a
      // gap" — `startAdjustingGap` reads currentGap=0 and applies the
      // drag delta as-is. The hover BG overlay below skips when
      // gapH<2 because there's no visible region to highlight, but
      // the draggable rod still mounts on the seam.

      const centerX = (frameRect.left + frameRect.right) / 2;
      const centerY = (gapTop + gapBottom) / 2;

      // Background overlay (visible on hover) — only when there's a
      // real gap to highlight.
      if (gapH >= 2) {
        gapElements.push(
          <div
            key={`gap-bg-${i}`}
            style={{
              position: 'fixed',
              left: frameRect.left,
              top: gapTop,
              width: frameRect.width,
              height: gapH,
              backgroundColor: 'rgba(244, 114, 182, 0.1)',
              opacity: hoveredGapIndex === i ? 1 : 0,
              transition: 'opacity 150ms',
              pointerEvents: 'none',
              zIndex: 3,
            }}
          />
        );
      }

      // Draggable handle
      gapElements.push(
        <div
          key={`gap-handle-${i}`}
          data-gap-handle=""
          onPointerDown={startAdjustingGap}
          onPointerEnter={() => setHoveredGapIndex(i)}
          onPointerLeave={() => setHoveredGapIndex(null)}
          style={{
            position: 'fixed',
            left: centerX - handleW / 2,
            top: centerY - handleH / 2,
            width: handleW,
            height: handleH,
            borderRadius: handleH / 2,
            backgroundColor: '#f472b6',
            cursor: 'ns-resize',
            pointerEvents: 'all',
            zIndex: 4,
          }}
        />
      );
    } else {
      const gapLeft = r1.right;
      const gapRight = r2.left;
      const gapW = gapRight - gapLeft;
      // Same as the column branch: render the handle at zero gap so
      // the user can grab it to start adding gap. Hover overlay only
      // when there's a visible region to highlight.

      const centerX = (gapLeft + gapRight) / 2;
      const centerY = (frameRect.top + frameRect.bottom) / 2;

      // Background overlay — only when there's a real gap.
      if (gapW >= 2) {
        gapElements.push(
          <div
            key={`gap-bg-${i}`}
            style={{
              position: 'fixed',
              left: gapLeft,
              top: frameRect.top,
              width: gapW,
              height: frameRect.height,
              backgroundColor: 'rgba(244, 114, 182, 0.1)',
              opacity: hoveredGapIndex === i ? 1 : 0,
              transition: 'opacity 150ms',
              pointerEvents: 'none',
              zIndex: 3,
            }}
          />
        );
      }

      // Draggable handle (note: width/height swapped for horizontal)
      gapElements.push(
        <div
          key={`gap-handle-${i}`}
          data-gap-handle=""
          onPointerDown={startAdjustingGap}
          onPointerEnter={() => setHoveredGapIndex(i)}
          onPointerLeave={() => setHoveredGapIndex(null)}
          style={{
            position: 'fixed',
            left: centerX - handleH / 2,
            top: centerY - handleW / 2,
            width: handleH,
            height: handleW,
            borderRadius: handleH / 2,
            backgroundColor: '#f472b6',
            cursor: 'ew-resize',
            pointerEvents: 'all',
            zIndex: 4,
          }}
        />
      );
    }
  }

  return <>{gapElements}</>;
}
