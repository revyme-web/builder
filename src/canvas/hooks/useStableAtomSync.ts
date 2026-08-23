// src/canvas/hooks/useStableAtomSync.ts
//
// Mirrors `code`, `projectVersion`, and `nodes` into their stable counterparts
// (`stableCodeAtom`, `stableProjectVersionAtom`, `stableNodesAtom`) — but only
// while the canvas is NOT being interacted with. During a fast drag/resize,
// every reparent runs `modifyProjectFile` which bumps version and invalidates
// ~14 derived parser atoms. Routing parsers through the stable atoms means
// the cascade fires once on drag end instead of N times during the drag.
// The Renderer + nodesAtom keep deriving from the live atoms so the canvas
// itself is never stale.

import { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  codeAtom, nodesAtom, stableCodeAtom, stableNodesAtom, canvasInteractingAtom,
} from '@/code/stores/store';
import { projectVersionAtom, stableProjectVersionAtom } from '@/code/project/project-fs';
import { trace } from '@/shared/debug-trace';

/** Leaf HOST for the sync hook. Rendering `<StableAtomSyncHost />` instead of
 *  calling the hook inside a big component (Canvas) keeps the hook's per-commit
 *  `nodesAtom`/`codeAtom`/`projectVersionAtom` subscriptions on THIS
 *  null-rendering fiber — the mirror still syncs on every commit, but the
 *  hosting component's whole subtree no longer re-renders for it. */
export function StableAtomSyncHost(): null {
  useStableAtomSync();
  return null;
}

// ─── Expedite ───────────────────────────────────────────────────────────────
//
// The 450ms deadline below buys the CANVAS time to paint before the parser
// cascade runs. That trade is right for a drag or an undo — a burst of writes
// whose visible result is on the canvas. It is exactly wrong for a PANEL edit:
// the user clicked a control and is looking at that control, so the 450ms is
// the whole perceived latency. Binding a CMS field landed in the source in 1ms
// and parsed in 5ms, but the properties panel reads the MIRROR, so the pill
// took ~half a second to appear (user report + trace 2026-08-08).
//
// A panel-originated write calls `expediteStableAtomSync()` to say "nothing on
// the canvas needs protecting from this one" — the next scheduled mirror runs
// on the next tick instead. One-shot: consumed by the scheduling that follows,
// so it can never leave the mirror permanently eager.
let _expedite = false;

/** Make the NEXT stable-atom mirror fire immediately instead of after the
 *  canvas-protection delay. Call from panel actions whose result the user is
 *  waiting to see in a panel (CMS bind/unbind, variable bind, prop writes). */
export function expediteStableAtomSync(): void {
  _expedite = true;
}

/** Read-and-clear the expedite flag. One-shot by construction: a single panel
 *  click can never leave the mirror permanently eager, which would cost undo
 *  and drags the paint-first budget the delay exists to buy. Exported so the
 *  contract is testable without mounting the hook. */
export function consumeExpedite(): boolean {
  const v = _expedite;
  _expedite = false;
  return v;
}

export function useStableAtomSync() {
  const code = useAtomValue(codeAtom);
  const nodes = useAtomValue(nodesAtom);
  const canvasInteracting = useAtomValue(canvasInteractingAtom);
  const projectVersion = useAtomValue(projectVersionAtom);

  const stableCode = useAtomValue(stableCodeAtom);
  const stableNodes = useAtomValue(stableNodesAtom);
  const stableProjectVersion = useAtomValue(stableProjectVersionAtom);

  const setStableCode = useSetAtom(stableCodeAtom);
  const setStableNodes = useSetAtom(stableNodesAtom);
  const setStableProjectVersion = useSetAtom(stableProjectVersionAtom);

  // Latest values for the max-latency timer to read at FIRE time.
  const liveRef = useRef({ code, nodes, projectVersion, canvasInteracting, stableCode, stableNodes, stableProjectVersion });
  liveRef.current = { code, nodes, projectVersion, canvasInteracting, stableCode, stableNodes, stableProjectVersion };
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (canvasInteracting) return;
    if (stableCode === code && stableProjectVersion === projectVersion && stableNodes === nodes) return;
    // Defer the mirror ONE FRAME. Setting the stable atoms synchronously here
    // fires the whole stable-derived cascade (~14 parser atoms + their
    // subscribers) inside the SAME task as the commit render — and the canvas
    // sandbox iframe shares this event loop, so its render task (the thing
    // that makes an edit visually land) had to wait behind that second React
    // pass. Stable atoms are BY DESIGN a lagging mirror (they already pause
    // for whole drags), so one rAF of extra lag is semantically free and lets
    // the canvas paint first. The cleanup cancels a pending sync if inputs
    // change again first — the next effect run re-schedules with the latest.
    // setTimeout(200), NOT rAF (measured 2026-07): rAF fires at the first
    // frame boundary after the commit — for UNDO that queued this cascade's
    // ~110ms task AHEAD of the iframe's render message, so the canvas revert
    // waited behind it (~320ms). The browser services the iframe only once
    // the parent backlog drains; a 200ms timeout guarantees the visual (and
    // its measure pass) goes first. Stable atoms are a lagging mirror BY
    // CONTRACT (they already pause for whole drags) — parser-atom consumers
    // seeing data ~450ms late is imperceptible. (450 not 200: at 200 the
    // mirror's ~100ms cascade landed exactly when the selection overlay's
    // starved catch-up poll needed the thread after an undo — the overlay
    // visibly lagged the node. 450 clears the whole undo settle window.)
    // MAX-LATENCY, not debounce (2026-07-23): the old cancel-and-reschedule
    // cleanup meant EVERY input change reset the 450ms clock — a burst of
    // sequential writes (create page → client half → per-locale wrapper
    // pages → providers sync) compounded into multi-second stable lag, so
    // panels deriving from the mirror (Pages tree) appeared ~2s late. A
    // pending timer now keeps its ORIGINAL deadline and mirrors the LATEST
    // values at fire time (via ref); drags stay paused — if an interaction
    // is live when the timer fires, we skip and the drag-end effect run
    // reschedules.
    // Panel-originated edit → no canvas paint to protect, so don't make the
    // user wait out the canvas budget to see their own click land.
    //
    // Read the flag BEFORE the pending-timer check. It used to be read after,
    // which meant an expedite arriving while a mirror was already pending was
    // both IGNORED (the panel still waited out the old deadline) and LEAKED —
    // the flag stayed set and expedited whatever wrote next, skipping a canvas
    // paint budget that write did need. Reading it here consumes it exactly
    // once per run that has real work to do.
    const expedited = consumeExpedite();
    if (pendingRef.current !== null) {
      // MAX-LATENCY: a pending timer keeps its ORIGINAL deadline so a burst of
      // writes can't postpone the mirror indefinitely. An expedite may pull it
      // EARLIER — never later — so the contract still holds.
      if (!expedited) return;
      clearTimeout(pendingRef.current);
      pendingRef.current = null;
    }
    const delay = expedited ? 0 : 450;
    pendingRef.current = setTimeout(() => {
      pendingRef.current = null;
      const L = liveRef.current;
      if (L.canvasInteracting) return;
      trace.fn('stable-atom-sync:deferred-mirror', { codeChanged: L.stableCode !== L.code, nodesChanged: L.stableNodes !== L.nodes });
      if (L.stableCode !== L.code) setStableCode(L.code);
      if (L.stableProjectVersion !== L.projectVersion) setStableProjectVersion(L.projectVersion);
      if (L.stableNodes !== L.nodes) setStableNodes(L.nodes);
    }, delay);
  }, [
    canvasInteracting, code, projectVersion, nodes,
    stableCode, stableProjectVersion, stableNodes,
    setStableCode, setStableProjectVersion, setStableNodes,
  ]);
  // Unmount only — a dep-change must NOT cancel the pending deadline.
  useEffect(() => () => { if (pendingRef.current !== null) clearTimeout(pendingRef.current); }, []);
}
