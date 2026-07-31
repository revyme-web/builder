// useStaleRevealGate.ts — shared reveal gate for overlay layers that hide
// during canvas interaction (pan / zoom / drag) and freeze their geometry
// poll while hidden.
//
// The failure mode this guards: the layer's `paths`/rect state still holds
// PRE-interaction screen-space geometry when `canvasInteracting` flips
// false — the un-hide render commits with that stale geometry, and on a big
// page the idle burst (culling restore + measure + render long tasks)
// starves the recompute for ~0.5s, so the layer visibly reappears at the OLD
// camera's scale/offset and then snaps. (Live find 2026-07-19: slot
// connector arrows re-appearing "huge, shooting off-canvas" after a zoom
// out.)
//
// "A recompute ran" is NOT enough to open the gate: after an extreme zoom
// the sync rectCache itself still holds pre-interaction / culled-placeholder
// rects until the culling restore re-measures (verified live — the first
// post-idle compute reproduced the stale geometry exactly). So the gate
// verifies REAL freshness: it compares the sync-cached rect of a caller-
// chosen probe node against the LIVE iframe rect (async bridge read) and
// only opens once they agree — with a hard time cap so a probe that can
// never converge (deleted node, dead bridge) doesn't hide the layer forever.
//
// Usage:
//   const stale = useStaleRevealGate(isInteracting, 'slot-connectors',
//     () => pairs.length ? { nodeId: pairs[0].compId, vpId } : null);
//   …style: hidden while `isInteracting || stale`. The component's own
//   geometry poll keeps running every frame, so by the time the gate opens
//   the committed paths are derived from the same fresh cache.

import { useEffect, useRef, useState } from 'react';
import { findNodeRect, findNodeRectLiveMetaAsync } from '@/canvas/node-ops';
import { trace } from '@/shared/debug-trace';

export interface StaleRevealProbe {
  nodeId: string;
  vpId: string;
}

/** Max px drift between the cached and live rect that still counts as
 *  "fresh" — covers sub-pixel transform rounding. */
const FRESH_TOLERANCE_PX = 2.5;
/** Hard cap on the verification loop — after this the gate opens anyway
 *  (hidden-but-never-revealed is worse than one stale frame). 6s covers the
 *  big page's full culling-restore + re-measure window with margin. */
const VERIFY_CAP_MS = 6000;
/** Bound on probes verified per attempt — keeps the per-frame Comlink batch
 *  sane when a layer has very many endpoints. */
const MAX_PROBES = 40;

function rectsAgree(a: DOMRect, b: DOMRect): boolean {
  return (
    Math.abs(a.x - b.x) <= FRESH_TOLERANCE_PX &&
    Math.abs(a.y - b.y) <= FRESH_TOLERANCE_PX &&
    Math.abs(a.width - b.width) <= FRESH_TOLERANCE_PX &&
    Math.abs(a.height - b.height) <= FRESH_TOLERANCE_PX
  );
}

/** One endpoint's freshness verdict. Exported for tests.
 *  - both missing → nothing to draw for it → fresh.
 *  - CULLED with a cached rect → fresh: the cache holds the PROJECTED rect
 *    (culling replays lastEmittedMeasure for [data-culled]) and the live rect
 *    is unmeasurable behind the display:none placeholder. An offscreen
 *    slot-connected canvas node stays culled FOREVER — waiting on it held the
 *    connector arrows hidden until the 6s cap, re-armed by every pan (live
 *    find 2026-07-21).
 *  - otherwise both rects must exist and agree. */
export function endpointIsFresh(
  cached: DOMRect | null,
  live: DOMRect | null,
  culled: boolean,
): boolean {
  if (!cached && !live) return true;
  if (cached && !live && culled) return true;
  return !!(cached && live && rectsAgree(cached, live));
}

export function useStaleRevealGate(
  isInteracting: boolean,
  traceTag: string,
  probe: () => StaleRevealProbe[] | StaleRevealProbe | null,
): boolean {
  const [stale, setStale] = useState(false);
  const armedRef = useRef(false);
  // Latest probe without effect churn — the verify loop reads it per attempt.
  const probeRef = useRef(probe);
  probeRef.current = probe;

  useEffect(() => {
    if (isInteracting) {
      if (!armedRef.current) {
        armedRef.current = true;
        setStale(true);
        trace.action(`${traceTag}:stale-reveal-armed`, {});
      }
      return;
    }
    if (!armedRef.current) return;

    // Interaction just ended with the gate armed — verify freshness.
    let cancelled = false;
    const start = performance.now();
    const clear = (reason: string) => {
      armedRef.current = false;
      setStale(false);
      trace.action(`${traceTag}:stale-reveal-cleared`, { reason, elapsedMs: Math.round(performance.now() - start) });
    };
    // Verify EVERY probe endpoint, not just the first: each connector has
    // two ends and ANY of them can be culled — the live find (2026-07-19,
    // pan + cull-restore): the gate opened on pair[0]'s freshness while
    // OTHER pairs' slot components were still culled placeholders, so those
    // arrows revealed shooting off-screen until the restore re-measured.
    // An endpoint that IS culled at verify time counts as fresh via its
    // projected cache entry (endpointIsFresh) — a stay-culled offscreen
    // canvas node must not hold the layer hidden to the cap.
    const verify = async () => {
      if (cancelled) return;
      const raw = probeRef.current();
      const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).slice(0, MAX_PROBES);
      if (list.length === 0) { clear('no-probe'); return; }
      const checks = await Promise.all(list.map(async (p) => {
        const cached = findNodeRect(p.nodeId, p.vpId);
        const { rect: live, culled } = await findNodeRectLiveMetaAsync(p.nodeId, p.vpId);
        return endpointIsFresh(cached, live, culled);
      }));
      if (cancelled) return;
      const staleCount = checks.filter(c => !c).length;
      if (staleCount === 0) { clear('fresh'); return; }
      if (performance.now() - start > VERIFY_CAP_MS) {
        trace.action(`${traceTag}:stale-reveal-cap-with-stale`, { staleCount, probeCount: list.length });
        clear('cap'); return;
      }
      requestAnimationFrame(() => { void verify(); });
    };
    void verify();
    return () => { cancelled = true; };
  }, [isInteracting, traceTag]);

  return stale;
}
