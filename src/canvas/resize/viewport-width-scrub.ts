// viewport-width-scrub.ts — the LIVE half of a viewport breakpoint width
// gesture, shared by every scrub surface (today: the SizeTool breakpoint
// chevron; the tile drag carries its own inline copy of the same steps in
// ResizeManager's viewport branch — keep the two in lockstep when editing).
//
// A width scrub must keep the tile's page content VISUALLY PINNED to the
// gesture's start state while only the tile box tracks the pointer —
// otherwise every width-keyed resolver (inline band merge,
// responsiveVariantMap, responsivePropStyles, conditional text) re-buckets
// at each intermediate width and elements jump around / flash the primary
// look mid-gesture ("during chevron drag elements are moving around and
// resolving different breakpoints; the overlay resize is perfectly stable",
// 2026-08-18 — the chevron had ported the drag's per-frame patch but not
// its band-pin machinery).
//
// Lifecycle, mirroring ResizeManager exactly:
//   begin — viewportBandPinOps.set(vpId, startWidth) + ONE pinned render.
//           The render stamps the pinned band state INLINE on every node and
//           sets containerType: normal on the pinned tile root (Renderer
//           consult), so band CSS hands over to identical inline values
//           atomically. Silencing container queries without that render
//           exposed the primary look on mousedown (2026-08-06).
//   tick  — patch the tile's width imperatively through the bridge (no
//           parse, no reconcile). When the width CROSSES a boundary that a
//           responsiveVariantMap / responsivePropStyles entry cares about,
//           write the live width into the (in-memory, file-scoped) widths
//           atom, updateLiveWidth, and force one render — template chrome
//           (layout::) resolves LIVE so the nav flips during the gesture;
//           page nodes keep resolving at the pin width. 120ms cooldown so
//           jitter across a boundary can't thrash renders.
//   end   — clear the pin WITHOUT a DOM restore: the caller's commit render
//           follows immediately, ships bandPin:null and re-stamps
//           containerType itself; a manual restore would only re-enable
//           stale bands for a frame (same rule as the drag's commit path).

import { getDefaultStore } from 'jotai';
import { viewportBandPinOps } from './viewport-band-pin-store';
import { getAllCachedNodes } from '@/code/stores/store';
import { viewportWidthsAtom } from '@/code/stores/viewport-store';
import { containerOverridesAtom } from '@/code/stores/container-query-store';
import { isComponentFilePath } from '@/code/project/active-file-store';
import { getContentRoot, patchNodeStyles, getViewportPrefix, forceCanvasRender } from '@/canvas/node-ops';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { resolveResponsiveUnits } from '@/shared/responsive-units';
import { trace } from '@/shared/debug-trace';

export interface ViewportWidthScrub {
  tick(width: number): void;
  end(): void;
}

// ─── Live vw/vh re-resolution ────────────────────────────────────────────────
// vw/vh values are stamped as INLINE px at render time against the simulated
// viewport (`resolveResponsiveUnits`: vw = width-proportional, vh = the
// width-based device-class height ratio). A width scrub therefore leaves
// them frozen at the gesture's start width and they snap on the commit
// render — the "hero jumps on mouseup" report (2026-08-18). These helpers
// collect every style carrying vw/vh ONCE at gesture start and re-resolve
// just those keys per tick through the bridge, so the commit render lands on
// identical values (same formula, same inputs) and nothing jumps.

/** Effective vw/vh-carrying style entries for a tile at `pinnedWidth`: the
 *  covering band's value wins per prop over the base; a band override with a
 *  concrete (non-viewport-unit) value REMOVES the base entry (the tile
 *  renders the band's px, not the base's vh). Pure — exported for tests. */
export function collectViewportUnitEntries(
  nodes: Iterable<{ id: string; styles?: Record<string, string> }>,
  overridesByNode: Map<string, Map<number, Map<string, string>>>,
  pinnedWidth: number,
): Array<{ nodeId: string; key: string; raw: string }> {
  const hasUnit = (v: unknown): v is string =>
    typeof v === 'string' && (v.includes('vw') || v.includes('vh'));
  const out: Array<{ nodeId: string; key: string; raw: string }> = [];
  for (const n of nodes) {
    const effective = new Map<string, string>();
    for (const [k, v] of Object.entries(n.styles ?? {})) {
      if (hasUnit(v)) effective.set(k, v);
    }
    const bands = overridesByNode.get(n.id);
    if (bands) {
      // Covering band = smallest max-width ≥ the pinned width (band
      // intervals are exclusive and seamless — same rule as bandForWidth).
      const band = [...bands.keys()].sort((a, b) => a - b).find(w => w >= pinnedWidth);
      if (band !== undefined) {
        for (const [k, v] of bands.get(band)!) {
          if (hasUnit(v)) effective.set(k, v);
          else effective.delete(k);
        }
      }
    }
    for (const [key, raw] of effective) out.push({ nodeId: n.id, key, raw });
  }
  return out;
}

/** Start the live vw/vh patcher for a viewport width gesture. Collects the
 *  vw/vh-carrying styles once; `tick` re-resolves them at the live width and
 *  patches imperatively (a handful of bridge writes — no render). Used by
 *  BOTH the SizeTool chevron scrub (via beginViewportWidthScrub) and
 *  ResizeManager's tile drag. */
export function beginViewportUnitLivePatch(vpId: string, pinnedWidth: number, rootNodeId?: string): { tick(width: number): void } {
  const entries = collectViewportUnitEntries(
    getAllCachedNodes(),
    getDefaultStore().get(containerOverridesAtom),
    pinnedWidth,
  );
  if (entries.length > 0) {
    trace.action('vp-width-scrub:vh-live-entries', { vpId, count: entries.length });
  }
  const vpPrefix = getViewportPrefix(vpId);
  return {
    tick(width: number) {
      const w = Math.round(width);
      // Keep the tile's `data-viewport-width` ATTR live too — patchElement
      // resolves vw/vh from that attribute, and a delta commit render that
      // skips the viewport-root loop would otherwise resolve at the STALE
      // start width and overwrite the live values back down on mouseup
      // (the 405-vs-412.56 e2e catch, 2026-08-18).
      if (rootNodeId) {
        getCanvasBridge().patchAttrsAndStyles(rootNodeId, vpPrefix, { 'data-viewport-width': String(w) }, {});
      }
      if (entries.length === 0) return;
      const contentEl = getContentRoot();
      if (!contentEl) return;
      const byNode = new Map<string, Record<string, string>>();
      for (const e of entries) {
        let styles = byNode.get(e.nodeId);
        if (!styles) { styles = {}; byNode.set(e.nodeId, styles); }
        styles[e.key] = resolveResponsiveUnits(e.raw, w);
      }
      for (const [nodeId, styles] of byNode) {
        patchNodeStyles(contentEl, nodeId, vpPrefix, styles);
      }
    },
  };
}

export function beginViewportWidthScrub(args: {
  vpId: string;
  nodeId: string;
  startWidth: number;
  activeFilePath: string | null;
}): ViewportWidthScrub {
  const { vpId, nodeId, startWidth, activeFilePath } = args;

  // Collect every breakpoint boundary the render-time resolvers care about
  // (same collection as ResizeManager's bandCrossingBoundaries).
  const bounds = new Set<number>();
  const pinnable = !!activeFilePath && !isComponentFilePath(activeFilePath);
  if (pinnable) {
    for (const n of getAllCachedNodes()) {
      if (n.responsiveVariantMap) {
        for (const k of Object.keys(n.responsiveVariantMap)) {
          const kn = Number(k);
          if (Number.isFinite(kn)) bounds.add(kn);
        }
      }
      if (n.responsivePropStyles) {
        for (const k of Object.keys(n.responsivePropStyles)) {
          const kn = Number(k);
          if (Number.isFinite(kn)) bounds.add(kn);
        }
      }
    }
  }
  const boundaries = [...bounds].sort((a, b) => a - b);
  // Same interval rule as resolve-core.responsiveVariantForWidth: the band a
  // width falls in = smallest boundary ≥ width; above every boundary = null.
  const bandForWidth = (w: number): number | null => boundaries.find((b) => b >= w) ?? null;

  let pinActive = false;
  if (pinnable) {
    viewportBandPinOps.set(vpId, startWidth);
    forceCanvasRender();
    pinActive = true;
    trace.action('vp-width-scrub:band-pin', { vpId, atWidth: startWidth });
  }

  // vw/vh styles are inline-stamped px keyed to the tile width — re-resolve
  // them per tick so the commit render lands on identical values (no jump).
  const unitLive = beginViewportUnitLivePatch(vpId, startWidth, nodeId);

  let lastRenderedBand = bandForWidth(startWidth);
  let lastBandRenderAt = 0;

  return {
    tick(width: number) {
      const contentEl = getContentRoot();
      if (contentEl) {
        patchNodeStyles(contentEl, nodeId, getViewportPrefix(vpId), { width: `${Math.round(width)}px` });
      }
      unitLive.tick(width);
      const band = bandForWidth(width);
      if (band !== lastRenderedBand && performance.now() - lastBandRenderAt > 120) {
        lastRenderedBand = band;
        lastBandRenderAt = performance.now();
        const liveW = Math.round(width);
        viewportBandPinOps.updateLiveWidth(liveW);
        getDefaultStore().set(viewportWidthsAtom, (prev) => ({ ...prev, [vpId]: liveW }));
        forceCanvasRender();
        trace.action('vp-width-scrub:band-crossing-rerender', { vpId, width: liveW, band });
      }
    },
    end() {
      if (!pinActive) return;
      pinActive = false;
      viewportBandPinOps.clear();
      trace.action('vp-width-scrub:band-pin-clear', { vpId });
    },
  };
}
