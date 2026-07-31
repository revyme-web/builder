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
    if (pendingRef.current !== null) return;
    pendingRef.current = setTimeout(() => {
      pendingRef.current = null;
      const L = liveRef.current;
      if (L.canvasInteracting) return;
      trace.fn('stable-atom-sync:deferred-mirror', { codeChanged: L.stableCode !== L.code, nodesChanged: L.stableNodes !== L.nodes });
      if (L.stableCode !== L.code) setStableCode(L.code);
      if (L.stableProjectVersion !== L.projectVersion) setStableProjectVersion(L.projectVersion);
      if (L.stableNodes !== L.nodes) setStableNodes(L.nodes);
    }, 450);
  }, [
    canvasInteracting, code, projectVersion, nodes,
    stableCode, stableProjectVersion, stableNodes,
    setStableCode, setStableProjectVersion, setStableNodes,
  ]);
  // Unmount only — a dep-change must NOT cancel the pending deadline.
  useEffect(() => () => { if (pendingRef.current !== null) clearTimeout(pendingRef.current); }, []);
}
