// SlotConnectors.tsx — persistent connector arrows for code-component slots.
//
// Draws a line from each slot-bearing code component to every canvas node
// connected into its slot. The line exits the component's right edge (the
// connection handle) with a straight horizontal run past the viewport's
// right edge, then switches to the regular angled stepped path.
//
// Two-layer z-rendering so it reads like the reference:
//   - TOP layer  — clipped to the SOURCE viewport's rect, so the exit from
//     the connection handle is drawn OVER the viewport (visible).
//   - BEHIND layer (zIndex -1, behind the transparent iframe) — the rest,
//     so where the line crosses any viewport out on the canvas it's hidden
//     behind it, and on the dark canvas it shows through.

import { useState, useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { codeAtom, selectedNodeAtom, slotReconnectDragAtom, canvasInteractingAtom } from '@/code/stores/store';
import { useNodesComputed } from '@/code/stores/node-family';
import { suppressSelectionOverlayAtom } from '@/code/stores/editor-store';
import { activeFilePathAtom, isComponentFilePath } from '@/code/project/active-file-store';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { findNodeRect } from '@/canvas/node-ops';
import { cornersFromRect } from '@/canvas/resize/geometry-utils';
import { getEdgeCenterFromQuad, getClosestEdgeCenterFromQuad, generateSlotConnectorPath } from '@/canvas/ui/arrow-path';
import { ARROW_COLOR, ARROW_COLOR_GREYED } from '@/canvas/ui/arrow-color';
import { getAllSlotConnections } from '@/code/generation/slot-ops';
import { useStaleRevealGate } from '@/canvas/hooks/useStaleRevealGate';
import type { CanvasNode } from '@/code/parsing/parser';
import { trace } from '@/shared/debug-trace';

/** Small gap past the viewport's right edge before the connector turns. */
const PAST_VIEWPORT = 14;

interface SlotPath {
  d: string;
  /** Clip strip (screen px) for the top layer — just the horizontal exit
   *  run from the handle to the elbow. Only this segment draws OVER the
   *  viewport; the corner + diagonal stay on the behind layer. */
  clip: { x: number; y: number; w: number; h: number };
  /** Endpoints — so the connector is purple only when one of them is
   *  selected (same rule as variant connectors), else greyed. */
  compId: string;
  childId: string;
}

export default function SlotConnectors() {
  // Per-computation subscription (pairs below) — this connector layer no
  // longer re-renders on every commit, only when the slot-connection pairs
  // actually change.
  const code = useAtomValue(codeAtom);
  const vpId = useAtomValue(interactingViewportIdAtom);
  const selectedId = useAtomValue(selectedNodeAtom);
  const reconnectingId = useAtomValue(slotReconnectDragAtom);
  // Hidden while the canvas is being interacted with (drag / pan / zoom) —
  // same rule as the variant ArrowConnectors. A ref so the RAF poll can read
  // it without re-subscribing.
  const isInteracting = useAtomValue(canvasInteractingAtom);
  const interactingRef = useRef(isInteracting);
  interactingRef.current = isInteracting;
  // Same suppression as the SelectionOverlay — hides this layer during a
  // file switch so its RAF poll doesn't paint against stale rects from the
  // previous file (data-ids can collide between page and component master).
  const suppressOverlay = useAtomValue(suppressSelectionOverlayAtom);
  // Clear paths on file switch — see the matching reset in
  // SelectionOverlay. Without this the connectors paint against
  // pre-switch rects until the next poll lands fresh.
  const activeFilePath = useAtomValue(activeFilePathAtom);
  const [paths, setPaths] = useState<SlotPath[]>([]);
  useEffect(() => { setPaths([]); }, [activeFilePath]);
  // STALE-REVEAL gate: keep the svg hidden after a pan/zoom until the first
  // COMPLETED post-interaction poll commits fresh geometry (see
  // useStaleRevealGate for the failure mode — this layer was the live find:
  // slot arrows re-appearing huge after a zoom out).
  const pairsRef = useRef<{ compId: string; childId: string; rootId: string }[]>([]);
  // Probe EVERY connector endpoint (component side in the interacting vp,
  // canvas-node side under the primary prefix) — a single-endpoint probe let
  // the gate open while OTHER pairs' slot components were still culled, and
  // those arrows revealed shooting off-screen (live find, pan+cull-restore).
  const revealStale = useStaleRevealGate(isInteracting, 'slot-connectors', () => {
    const out: { nodeId: string; vpId: string }[] = [];
    const seen = new Set<string>();
    for (const pr of pairsRef.current) {
      for (const [nid, vp] of [[pr.compId, vpId || 'desktop'], [pr.childId, 'desktop']] as const) {
        const k = `${nid}|${vp}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ nodeId: nid, vpId: vp });
      }
    }
    return out;
  });

  const isComponentFile = isComponentFilePath(activeFilePath);

  // Every connection: component → connected canvas node, plus the
  // component's viewport-root id (used to route + clip).
  //
  // Visibility rule differs by file type:
  //
  //   • PAGE       — show ALL pairs all the time. The grey arrows are a
  //                  page-level affordance ("this slot is wired to that
  //                  frame") visible whether or not anything is selected.
  //
  //   • MASTER     — show ALL pairs only when SOMETHING is selected.
  //     (design     With nothing selected the master canvas is in
  //      component  "neutral overview" mode and the slot mesh would
  //      file)      visually compete with the variant viewports for
  //                 attention. As soon as the user clicks a variant
  //                 root, a child, the Marquee, anything — pairs paint.
  //                 (Color: purple when the selection IS source/target,
  //                 grey otherwise — see `colorFor`.)
  //
  // Color discriminates regardless of file type: purple when the
  // selection IS the source or target, grey otherwise.
  //
  // History: the master-entry FLASH the selection scope used to defend
  // against is now handled by stronger layers.
  const pairs = useNodesComputed((nodes) => {
    const out: { compId: string; childId: string; rootId: string }[] = [];
    // On a design-component master, suppress entirely until the user
    // picks something. Pages keep the always-on behavior.
    if (isComponentFile && !selectedId) return out;
    for (const [compId, childIds] of getAllSlotConnections(code)) {
      // Component whose connection is being re-dragged from its handle —
      // hide its persistent connector so the link reads as "detached".
      if (compId === reconnectingId) continue;
      const comp = nodes.get(compId);
      if (!comp) continue;
      let r: CanvasNode | undefined = comp;
      while (r && r.parentId) r = nodes.get(r.parentId);
      const rootId = r?.id ?? '';
      for (const childId of childIds) out.push({ compId, childId, rootId });
    }
    return out;
  }, [code, reconnectingId, isComponentFile, selectedId]);
  // Mirror for the reveal gate's probe (called from its verify loop).
  pairsRef.current = pairs;

  useEffect(() => {
    if (pairs.length === 0) { setPaths([]); return; }
    trace.fn('SlotConnectors:track', { pairCount: pairs.length });
    let raf: number;
    const poll = () => {
      // While interacting, freeze the paths (skip recompute) — the SVG is
      // hidden anyway; this also avoids chasing mid-drag rects.
      if (interactingRef.current) {
        raf = requestAnimationFrame(poll);
        return;
      }
      const next: SlotPath[] = [];
      for (const { compId, childId, rootId } of pairs) {
        // Canvas nodes are cached under the primary ('') prefix — look them
        // up with 'desktop' (getViewportPrefix('') wrongly yields '-').
        const sourceRect = findNodeRect(compId, vpId || 'desktop');
        const targetRect = findNodeRect(childId, 'desktop');
        if (!sourceRect || !targetRect) continue;

        const fromQuad = cornersFromRect(sourceRect);
        const toQuad = cornersFromRect(targetRect);
        // Always leave from the component's right edge — the slot handle.
        const sEdge = getEdgeCenterFromQuad(fromQuad, 'right');
        const vpRect = rootId ? findNodeRect(rootId, vpId || 'desktop') : null;
        const exitX = vpRect ? vpRect.right + PAST_VIEWPORT : sEdge.point.x + 48;
        const elbow = { x: Math.max(exitX, sEdge.point.x + 12), y: sEdge.point.y };
        const tEdge = getClosestEdgeCenterFromQuad(toQuad, elbow);
        next.push({
          d: generateSlotConnectorPath(sEdge.point, tEdge.point, tEdge.dir, exitX),
          // Top layer shows ONLY the horizontal exit run (handle → elbow).
          clip: {
            x: sEdge.point.x,
            y: sEdge.point.y - 4,
            w: Math.max(0, elbow.x - sEdge.point.x),
            h: 8,
          },
          compId,
          childId,
        });
      }
      // Only re-render when something actually moved.
      setPaths(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, [pairs, vpId]);

  if (paths.length === 0 || suppressOverlay) return null;

  const svgBase: React.CSSProperties = {
    position: 'fixed', left: 0, top: 0,
    width: '100vw', height: '100vh',
    pointerEvents: 'none',
    // Hide during canvas interaction (drag / pan / zoom) AND until the first
    // fresh post-interaction poll commits (stale-reveal gate), fade back
    // after — identical to ArrowConnectors.
    opacity: isInteracting || revealStale ? 0 : 1,
    visibility: isInteracting || revealStale ? 'hidden' : 'visible',
    transition: isInteracting || revealStale ? 'none' : 'opacity 0.15s',
  };

  // Purple only when the connector's source OR target is selected — same
  // rule as variant connectors; otherwise greyed.
  const colorFor = (p: SlotPath): string =>
    selectedId && (selectedId === p.compId || selectedId === p.childId)
      ? ARROW_COLOR
      : ARROW_COLOR_GREYED;

  return (
    <>
      {/* Behind layer — below the transparent iframe; hidden behind any
          viewport it crosses, visible on the dark canvas. */}
      <svg data-slot-connectors="behind" style={{ ...svgBase, zIndex: -1 }}>
        {paths.map((p, i) => (
          <path key={i} d={p.d} fill="none" stroke={colorFor(p)} strokeWidth={2} strokeLinecap="round" />
        ))}
      </svg>

      {/* Top layer — each path clipped to its horizontal-exit strip, so
          ONLY the run from the handle to the elbow draws OVER the viewport.
          The corner + diagonal fall outside the strip → behind layer only. */}
      <svg data-slot-connectors="front" style={{ ...svgBase, zIndex: 2 }}>
        <defs>
          {paths.map((p, i) => (
            <clipPath key={i} id={`slot-clip-${i}`}>
              <rect x={p.clip.x} y={p.clip.y} width={p.clip.w} height={p.clip.h} />
            </clipPath>
          ))}
        </defs>
        {paths.map((p, i) => (
          <path
            key={i}
            d={p.d}
            clipPath={`url(#slot-clip-${i})`}
            fill="none"
            stroke={colorFor(p)}
            strokeWidth={2}
            strokeLinecap="round"
          />
        ))}
      </svg>
    </>
  );
}
