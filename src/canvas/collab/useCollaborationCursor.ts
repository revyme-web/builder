// useCollaborationCursor.ts — Broadcast the local mouse position to
// the collab room. Throttled to ~30fps + 2px movement threshold, with
// a 2s heartbeat so receivers know the cursor is still "alive" even
// when the user holds still.
//
// COORDINATE SPACE: we send CANVAS-CONTENT coordinates, NOT screen
// pixels. Every user has an independent pan + zoom on their canvas,
// so a `(300, 200)` screen pixel maps to a different content point
// for each viewer. The sender converts screen → canvas-content using
// their own `transformManager`, and each receiver converts back using
// THEIR transformManager — so a cursor sitting on element X in the
// sender's canvas renders on element X in every viewer's canvas
// regardless of how each user has the canvas panned or zoomed.
//
// Mirrors the old builder's `screenToCanvas` formula
// (`revyme-old/.../dnd-utils.tsx:714-724`):
//   canvas.x = (clientX - containerLeft - pan.x) / scale
//   canvas.y = (clientY - containerTop  - pan.y) / scale

import { useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { transformManager } from '@/canvas/transform/TransformManager';
import { useCollaboration } from './CollaborationProvider';

const THROTTLE_MS = 33; // ~30fps
const HEARTBEAT_MS = 2000;
const MOVE_THRESHOLD_CANVAS_PX = 2;

/** Convert a screen-space `clientX/Y` into canvas-content space using
 *  the local user's current pan + zoom. The result is the point in
 *  "what the canvas content thinks of as its own coordinates" — the
 *  same number every collaborator will use to reason about that
 *  position regardless of their own pan/zoom. */
function screenToCanvasContent(
  clientX: number,
  clientY: number,
  root: HTMLElement | null,
): { x: number; y: number } {
  const rect = root?.getBoundingClientRect();
  const transform = transformManager.getTransform();
  const left = rect?.left ?? 0;
  const top = rect?.top ?? 0;
  return {
    x: (clientX - left - transform.x) / transform.scale,
    y: (clientY - top - transform.y) / transform.scale,
  };
}

export function useCollaborationCursor() {
  const { isConnected, sendCursor } = useCollaboration();
  const activePage = useAtomValue(activeFilePathAtom);
  // Stable refs hold "last sent" state so we can guard re-sends from
  // the throttle without re-binding the listener every render.
  const lastSentAtRef = useRef<number>(0);
  const lastSentXRef = useRef<number>(-Infinity);
  const lastSentYRef = useRef<number>(-Infinity);
  const lastClientXRef = useRef<number>(0);
  const lastClientYRef = useRef<number>(0);

  useEffect(() => {
    if (!isConnected) return;

    // Cache the canvas-root lookup so we don't query the DOM on every
    // pointer event. Re-resolves once per effect cycle (handles canvas
    // mount/unmount within the lifetime of a single session fine).
    const root = document.querySelector('[data-canvas-root]') as HTMLElement | null;

    const send = (clientX: number, clientY: number) => {
      const { x, y } = screenToCanvasContent(clientX, clientY, root);
      lastSentAtRef.current = performance.now();
      lastSentXRef.current = x;
      lastSentYRef.current = y;
      sendCursor({ x, y, page: activePage ?? undefined });
    };

    const onMove = (e: PointerEvent) => {
      lastClientXRef.current = e.clientX;
      lastClientYRef.current = e.clientY;
      const now = performance.now();
      if (now - lastSentAtRef.current < THROTTLE_MS) return;
      const { x, y } = screenToCanvasContent(e.clientX, e.clientY, root);
      // 2px threshold is in CANVAS space — at zoom < 1 a 2-canvas-px
      // move is sub-pixel on screen and we should drop it; at zoom >
      // 1 the same canvas-px move is more visible and we still want
      // to fire. Canvas-space matches what receivers will render
      // with so it's the right unit.
      if (
        Math.abs(x - lastSentXRef.current) < MOVE_THRESHOLD_CANVAS_PX &&
        Math.abs(y - lastSentYRef.current) < MOVE_THRESHOLD_CANVAS_PX
      ) {
        return;
      }
      send(e.clientX, e.clientY);
    };

    window.addEventListener('pointermove', onMove, { passive: true });

    // Heartbeat — re-send the last position every 2s even without movement
    // so receivers can prune stale cursors (they drop anything not heard
    // from in 10s, see CollaborationProvider's stale sweep).
    const heartbeat = setInterval(() => {
      if (lastSentAtRef.current === 0) return;
      send(lastClientXRef.current, lastClientYRef.current);
    }, HEARTBEAT_MS);

    return () => {
      window.removeEventListener('pointermove', onMove);
      clearInterval(heartbeat);
    };
  }, [isConnected, sendCursor, activePage]);
}
