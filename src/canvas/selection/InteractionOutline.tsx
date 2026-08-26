// InteractionOutline.tsx — Thin accent border on selected element DURING interactions.
// Rendered as a screen-space SVG overlay (like SelectionBorder) so it's zoom-independent.
// Shown during resize, drag, rotate, style changes.
//
// Why this is imperative (refs + setAttribute, no setState):
// During fast drags / resizes the outline previously lagged a frame behind the
// element. The cause was the React render pipeline — setState on every RAF tick
// scheduled a render + commit before the SVG could update. With direct DOM
// attribute writes the RAF callback is the only thing between cornersCache and
// paint, so the outline tracks the element as tightly as the cache can supply.

import { useEffect, useLayoutEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { selectedNodeAtom, canvasInteractingAtom, isRotatingAtom, isComponentSelectedAtom } from '@/code/stores/store';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { getScreenCornersById, cornersEqual, type ScreenCorners } from '@/canvas/resize/geometry-utils';
import { trace } from '@/shared/debug-trace';

// Color determined at render time based on whether the selected node is a component
const BORDER_WIDTH = 0.5;

/** Apply a corners object to four `<line>` elements via setAttribute. */
function applyCorners(lines: (SVGLineElement | null)[], c: ScreenCorners): void {
  const edges = [
    { from: c.TL, to: c.TR },
    { from: c.TR, to: c.BR },
    { from: c.BR, to: c.BL },
    { from: c.BL, to: c.TL },
  ];
  for (let i = 0; i < 4; i++) {
    const line = lines[i];
    if (!line) continue;
    const e = edges[i];
    line.setAttribute('x1', String(e.from.x));
    line.setAttribute('y1', String(e.from.y));
    line.setAttribute('x2', String(e.to.x));
    line.setAttribute('y2', String(e.to.y));
  }
}

/**
 * Renders a thin accent border around the selected element during canvas interactions.
 * Uses screen-space SVG (like SelectionBorder) so the border width is always the same
 * regardless of canvas zoom level. Updates the four `<line>` elements imperatively
 * via refs so React renders zero times during the drag.
 */
export default function InteractionOutline() {
  const selectedId = useAtomValue(selectedNodeAtom);
  const vpId = useAtomValue(interactingViewportIdAtom);
  const isInteracting = useAtomValue(canvasInteractingAtom);
  const isRotating = useAtomValue(isRotatingAtom);
  const isComponent = useAtomValue(isComponentSelectedAtom);
  // Canvas overlay → `--selection`, not the amber brand accent. Components
  // keep their violet so instance-vs-node stays readable at a glance.
  const borderColor = isComponent ? 'var(--accent-secondary)' : 'var(--selection)';

  const lineRefs = useRef<(SVGLineElement | null)[]>([null, null, null, null]);
  const lastCornersRef = useRef<ScreenCorners | null>(null);

  // The outline used to be suppressed for any SVG selection (root or
  // child) because of a one-frame ghost during the post-mouseup refit
  // on SVG GROUPS. Suppressing all SVGs over-corrected: vectors and
  // sketches lost their drag outline entirely. Restore the outline
  // universally and read from `cornersCache` for every kind, including
  // SVGs — that cache stores the PAINTED bbox for SVGs (see
  // `cornersForElement` in bridge-sandbox.ts), which matches the
  // idle SelectionBorder. Using anything else (e.g. the wrapper rect)
  // makes the outline jump from "tight around strokes" (idle) to
  // "loose around the SVG layout box" (drag) — visible as the
  // outline expanding the moment the user starts dragging or
  // resizing, which is what this consistency fix prevents.
  //
  // (This component previously held a discarded `nodesAtom` subscription
  // here — `void nodes` — which only forced re-renders on every commit.
  // All updates are imperative via the RAF poll below; the subscription
  // was pure overhead and was removed in the per-node-subscription
  // migration.)

  // Hidden entirely while ROTATING: the screen-corner outline can't track a
  // live rotation cleanly (corners lag the spinning shape by a frame and the
  // rotation pivot isn't the bbox center), so a stale box lingers behind the
  // shape — visual noise the user explicitly asked to drop. Resize/drag keep
  // the outline; only rotate suppresses it.
  const active = !!(isInteracting && selectedId && !isRotating);

  // Synchronously seed the four <line> attributes with the initial corners
  // BEFORE the browser paints. Without this the outline mounts with empty
  // attributes and there's a 1-frame flash where it sits at origin (0,0).
  // useLayoutEffect runs after DOM mutation but before paint — perfect for
  // first-render layout reads/writes that mustn't be visible to the user.
  useLayoutEffect(() => {
    if (!active || !selectedId) return;
    const c = getScreenCornersById(selectedId, vpId);
    if (c) {
      applyCorners(lineRefs.current, c);
      lastCornersRef.current = c;
    }
  }, [active, selectedId, vpId]);

  // RAF loop drives subsequent updates imperatively. No setState, no re-render —
  // the cornersCache (populated by the iframe→parent `cornersUpdate` events)
  // is the single source of truth and we write straight to the DOM.
  useEffect(() => {
    if (!active || !selectedId) return;

    let rafId = 0;

    const poll = () => {
      const c = getScreenCornersById(selectedId, vpId);
      if (c && !cornersEqual(lastCornersRef.current, c)) {
        applyCorners(lineRefs.current, c);
        lastCornersRef.current = c;
      }
      rafId = requestAnimationFrame(poll);
    };

    rafId = requestAnimationFrame(poll);
    trace.action('interaction-outline:show', { selectedId, vpId });

    return () => {
      cancelAnimationFrame(rafId);
      lastCornersRef.current = null;
      trace.action('interaction-outline:hide', { selectedId, vpId });
    };
  }, [active, selectedId, vpId]);

  if (!active) return null;

  return (
    <svg
      data-interaction-outline
      style={{
        position: 'fixed', left: 0, top: 0,
        width: '100vw', height: '100vh',
        pointerEvents: 'none', overflow: 'visible', zIndex: 1,
      }}
    >
      {[0, 1, 2, 3].map((i) => (
        <line
          key={i}
          ref={(el) => { lineRefs.current[i] = el; }}
          stroke={borderColor}
          strokeWidth={BORDER_WIDTH}
        />
      ))}
    </svg>
  );
}
