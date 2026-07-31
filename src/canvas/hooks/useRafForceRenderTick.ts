// useRafForceRenderTick.ts — Shared drag-scoped RAF re-render pump (9.4c).
//
// Consolidates the identical rafTick/rafRef/isDraggingRef trio GapHandles and
// PaddingHandles each hand-rolled: while a handle drag is active, bump a tick
// state every animation frame to force a re-render so the component re-reads
// fresh rects from the bridge rectCache (`domOnly: true` patches update the
// cache but fire no React render until mouseup's full commit — without the
// pump, handles visually stayed at the pre-drag position the entire drag,
// then jumped on mouseup).
//
// `start()` at drag start, `stop()` on pointerup. The unmount cleanup covers
// switching the selected node away mid-drag (which would otherwise leak a RAF
// loop poking setState on a torn-down component) and the rare case where
// pointerup never fires (window blur, devtools open, etc).

import { useCallback, useEffect, useRef, useState } from 'react';

export function useRafForceRenderTick(): { tick: number; start: () => void; stop: () => void } {
  const [tick, setTick] = useState(0);
  const rafRef = useRef<number | null>(null);
  const activeRef = useRef(false);

  // Cancel any in-flight RAF on unmount mid-drag.
  useEffect(() => {
    return () => {
      activeRef.current = false;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  const start = useCallback(() => {
    // Idempotent: two independent callers now drive the same pump — a handle's
    // OWN drag and the `canvasInteracting` effect that keeps the handle tracking
    // while a DIFFERENT handle drags. A second start would spawn a parallel RAF
    // loop (rafRef only remembers the last one, so `stop` could never cancel the
    // orphan; it would spin until the next stop flipped activeRef).
    if (activeRef.current) return;
    activeRef.current = true;
    const pumpRaf = () => {
      if (!activeRef.current) return;
      setTick(t => t + 1);
      rafRef.current = requestAnimationFrame(pumpRaf);
    };
    rafRef.current = requestAnimationFrame(pumpRaf);
  }, []);

  const stop = useCallback(() => {
    activeRef.current = false;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  return { tick, start, stop };
}
